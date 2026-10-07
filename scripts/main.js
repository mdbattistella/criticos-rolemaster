const MOD = "criticos-rolemaster";
const SOCKET = `module.${MOD}`;
let TABLAS = null;

// Tipo de daño dnd5e -> tabla de crítico
const MAPEO_DANO = {
  slashing: "corte", bludgeoning: "aplastamiento", piercing: "perforacion",
  fire: "calor", cold: "frio", lightning: "electrico", thunder: "impacto"
};

const RE_SIN_ARMAS = /unarmed|sin armas|desarmad|arte[s]? marcial|martial|pu[ñn]o|patada|kick|punch|ki\b|r[aá]faga/i;

function tiposDano(item, activity) {
  const out = new Set();
  for (const p of activity?.damage?.parts ?? []) for (const t of p?.types ?? []) out.add(t);
  for (const t of item?.system?.damage?.base?.types ?? []) out.add(t);
  return [...out];
}

function tablaCritico(item, activity) {
  const id = item?.system?.identifier ?? "";
  if (id === "unarmed-strike" || RE_SIN_ARMAS.test(item?.name ?? "") || RE_SIN_ARMAS.test(activity?.name ?? "")) return "artes_marciales";
  const tipos = tiposDano(item, activity);
  const fisico = tipos.find(t => MAPEO_DANO[t]);
  if (fisico) return MAPEO_DANO[fisico];
  if (tipos.length) return "magico";
  // Sin tipo definido: arma física → aplastamiento, el resto → mágico
  return item?.type === "weapon" ? "aplastamiento" : "magico";
}

// Severidad por margen sobre la CA: 15+ = E, hacia abajo cada ~4
function severidad(margen) {
  if (margen >= 15) return "E";
  if (margen >= 12) return "D";
  if (margen >= 8) return "C";
  if (margen >= 4) return "B";
  return "A";
}

Hooks.once("init", () => {
  game.settings.register(MOD, "multDano", {
    name: "Conversión de daño de crítico",
    hint: "Multiplicador del daño extra de las tablas (1 = tal cual).",
    scope: "world", config: true, type: Number, default: 1
  });
  game.settings.register(MOD, "delayCritico", {
    name: "Demora del aviso de crítico/pifia (ms)",
    hint: "Espera antes de mostrar la tarjeta, para no adelantarse a la animación de dados. Con Dice So Nice espera a que termine la animación (este valor es el máximo).",
    scope: "world", config: true, type: Number, default: 2500
  });
});

const dormir = ms => new Promise(r => setTimeout(r, ms));

// Espera a que termine la animación de dados del ataque (Dice So Nice) o la demora configurada
async function esperarAnimacion() {
  const ms = Math.max(0, game.settings.get(MOD, "delayCritico") ?? 0);
  if (game.dice3d) {
    await Promise.race([
      new Promise(r => Hooks.once("diceSoNiceRollComplete", r)),
      dormir(Math.max(ms, 6000))
    ]);
    await dormir(300);
  } else {
    await dormir(ms);
  }
}

Hooks.once("ready", async () => {
  TABLAS = await (await fetch(`modules/${MOD}/data/tablas.json`)).json();
  game.socket.on(SOCKET, async (data) => {
    if (data?.accion !== "aplicarDano" || !game.user.isActiveGM) return;
    await aplicarDano(data.targetUuid, data.monto);
  });
});

// dnd5e puede disparar rollAttack y rollAttackV2 para la misma tirada: se procesa una sola vez
const PROCESADAS = new WeakSet();
for (const h of ["dnd5e.rollAttack", "dnd5e.rollAttackV2"]) {
  Hooks.on(h, (rolls, { subject } = {}) => onAtaque(rolls, subject));
}

async function onAtaque(rolls, activity) {
  const roll = rolls?.[0];
  if (!roll || PROCESADAS.has(roll)) return;
  PROCESADAS.add(roll);
  const d20 = roll.dice.find(d => d.faces === 20);
  const nat = d20?.results.find(r => r.active && !r.discarded)?.result;
  if (nat !== 20 && nat !== 1) return;

  const item = activity?.item;
  const target = game.user.targets.first();
  const targetUuid = target?.actor?.uuid ?? null;
  const ca = target?.actor?.system?.attributes?.ac?.value;

  let tabla, sev = null, detalle;
  if (nat === 20) {
    tabla = tablaCritico(item, activity);
    const margen = ca != null ? roll.total - ca : 0;
    sev = severidad(margen);
    detalle = ca != null ? `Total ${roll.total} vs CA ${ca} (margen ${margen})` : "Sin objetivo: severidad A";
  } else {
    const tipoAtq = activity?.attack?.type?.value;
    const clasif = activity?.attack?.type?.classification;
    tabla = clasif === "spell" ? "pifia_conjuro" : tipoAtq === "ranged" ? "pifia_distancia" : "pifia_cuerpo";
    detalle = item ? item.name : "";
  }

  await esperarAnimacion();

  const t = TABLAS?.[tabla];
  const titulo = nat === 20 ? `¡Crítico! ${t?.label} ${sev}` : `¡Pifia! ${t?.label}`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: item?.actor }),
    content: `<div class="crm-card ${nat === 1 ? "pifia" : ""}">
      <h3>${titulo}</h3>
      <div class="crm-tiradas">${detalle}${target ? ` · Objetivo: ${target.name}` : ""}</div>
      <button type="button" class="crm-tirar" data-tabla="${tabla}" data-sev="${sev ?? ""}"
        data-target="${targetUuid ?? ""}" data-actor="${item?.actor?.uuid ?? ""}">Tirar d100 de ${nat === 20 ? "crítico" : "pifia"}</button>
    </div>`
  });
}

// d100 abierta: 96+ vuelve a tirar y suma
// Las tiradas se adjuntan al mensaje: Dice So Nice las anima y recién después muestra el resultado
async function tiradaAbierta() {
  const rolls = [], tiradas = [];
  let total = 0, r;
  do {
    r = await new Roll("1d100").evaluate();
    rolls.push(r);
    tiradas.push(r.total);
    total += r.total;
  } while (r.total >= 96);
  return { total, tiradas, rolls };
}

async function onTirar(btn) {
  const { tabla, sev, target, actor } = btn.dataset;
  const t = TABLAS?.[tabla];
  if (!t) return ui.notifications.error(`Tabla "${tabla}" no encontrada`);
  const { total, tiradas, rolls } = await tiradaAbierta();
  const fila = t.filas.find(f => total >= f.min && total <= f.max) ?? t.filas.at(-1);
  const res = t.tipo === "critico" ? fila[sev] : fila;
  const monto = Math.round((res.dano ?? 0) * game.settings.get(MOD, "multDano"));
  const targetName = target ? (await fromUuid(target))?.name : null;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: actor ? await fromUuid(actor) : null }),
    rolls,
    sound: game.dice3d ? null : CONFIG.sounds.dice,
    content: `<div class="crm-card ${t.tipo === "pifia" ? "pifia" : ""}">
      <h3>${t.label}${sev ? ` <span class="crm-sev">${sev}</span>` : ""} — ${total}</h3>
      <div class="crm-tiradas">d100 abierta: ${tiradas.join(" + ")}</div>
      <div class="crm-texto">${res.texto}</div>
      ${res.efectos ? `<div><b>Efectos:</b> ${res.efectos}</div>` : ""}
      ${monto > 0 ? `<button type="button" class="crm-aplicar" data-monto="${monto}" data-target="${target ?? ""}">
        Aplicar ${monto} de daño${targetName ? ` a ${targetName}` : " (a seleccionados)"}</button>` : ""}
    </div>`
  });
}

async function aplicarDano(targetUuid, monto) {
  const actor = targetUuid ? await fromUuid(targetUuid) : null;
  if (actor) return actor.applyDamage(monto);
}

async function onAplicar(btn) {
  const monto = Number(btn.dataset.monto);
  const uuid = btn.dataset.target;
  if (!uuid) {
    for (const tk of canvas.tokens.controlled) await tk.actor?.applyDamage(monto);
    return;
  }
  const actor = await fromUuid(uuid);
  if (actor?.isOwner) return actor.applyDamage(monto);
  game.socket.emit(SOCKET, { accion: "aplicarDano", targetUuid: uuid, monto });
  ui.notifications.info("Daño enviado al DM para aplicar.");
}

Hooks.on("renderChatMessageHTML", (msg, html) => {
  html.querySelector(".crm-tirar")?.addEventListener("click", ev => {
    ev.currentTarget.disabled = true;
    onTirar(ev.currentTarget);
  });
  html.querySelector(".crm-aplicar")?.addEventListener("click", ev => onAplicar(ev.currentTarget));
});
