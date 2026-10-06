const MOD = "criticos-rolemaster";
const SOCKET = `module.${MOD}`;
let TABLAS = null;

// Tipo de daño dnd5e -> tabla de crítico
const MAPEO_DANO = {
  slashing: "corte", bludgeoning: "aplastamiento", piercing: "perforacion",
  fire: "calor", cold: "frio", lightning: "electrico", thunder: "impacto"
};

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
});

Hooks.once("ready", async () => {
  TABLAS = await (await fetch(`modules/${MOD}/data/tablas.json`)).json();
  game.socket.on(SOCKET, async (data) => {
    if (data?.accion !== "aplicarDano" || !game.user.isActiveGM) return;
    await aplicarDano(data.targetUuid, data.monto);
  });
});

// dnd5e 4.x usa rollAttackV2, 5.x usa rollAttack
for (const h of ["dnd5e.rollAttack", "dnd5e.rollAttackV2"]) {
  Hooks.on(h, (rolls, { subject } = {}) => onAtaque(rolls, subject));
}

async function onAtaque(rolls, activity) {
  const roll = rolls?.[0];
  if (!roll) return;
  const d20 = roll.dice.find(d => d.faces === 20);
  const nat = d20?.results.find(r => r.active && !r.discarded)?.result;
  if (nat !== 20 && nat !== 1) return;

  const item = activity?.item;
  const target = game.user.targets.first();
  const targetUuid = target?.actor?.uuid ?? null;
  const ca = target?.actor?.system?.attributes?.ac?.value;

  let tabla, sev = null, detalle;
  if (nat === 20) {
    const tipos = [...(activity?.damage?.parts?.[0]?.types ?? item?.system?.damage?.base?.types ?? [])];
    tabla = MAPEO_DANO[tipos[0]] ?? "magico";
    const margen = ca != null ? roll.total - ca : 0;
    sev = severidad(margen);
    detalle = ca != null ? `Total ${roll.total} vs CA ${ca} (margen ${margen})` : "Sin objetivo: severidad A";
  } else {
    const tipoAtq = activity?.attack?.type?.value;
    const clasif = activity?.attack?.type?.classification;
    tabla = clasif === "spell" ? "pifia_conjuro" : tipoAtq === "ranged" ? "pifia_distancia" : "pifia_cuerpo";
    detalle = item ? item.name : "";
  }

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
async function tiradaAbierta() {
  const tiradas = [];
  let total = 0, r;
  do {
    r = await new Roll("1d100").evaluate();
    if (game.dice3d) await game.dice3d.showForRoll(r, game.user, true);
    tiradas.push(r.total);
    total += r.total;
  } while (r.total >= 96);
  return { total, tiradas };
}

async function onTirar(btn) {
  const { tabla, sev, target, actor } = btn.dataset;
  const t = TABLAS?.[tabla];
  if (!t) return ui.notifications.error(`Tabla "${tabla}" no encontrada`);
  const { total, tiradas } = await tiradaAbierta();
  const fila = t.filas.find(f => total >= f.min && total <= f.max) ?? t.filas.at(-1);
  const res = t.tipo === "critico" ? fila[sev] : fila;
  const monto = Math.round((res.dano ?? 0) * game.settings.get(MOD, "multDano"));
  const targetName = target ? (await fromUuid(target))?.name : null;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: actor ? await fromUuid(actor) : null }),
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
