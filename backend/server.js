// ReWear Market - Plataforma completa (Express + PostgreSQL)
// Patron MVC: Modelo = PostgreSQL, Vista = React (../frontend), Controlador = este archivo.
//
// Funciona igual con Postgres local o con Supabase (Supabase es Postgres).
// Solo cambia la direccion en .env (DATABASE_URL). Para Supabase se activa SSL solo.
//
// Lo mas importante del Core (se valida y calcula en el SERVIDOR, nunca en el navegador):
//   - CREDITOS: valor = redondear(valor_base x factor_estado x multiplicador_marca); x1.2 si es autentica.
//   - Reservar retiene creditos en una transaccion para evitar el doble gasto.
//   - Las rarezas se desbloquean con el saldo; los niveles con reputacion e intercambios.
//
// Ejecutar:  npm install   y luego   npm start

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// --- Conexion a PostgreSQL (local o Supabase) ---
const connectionString = process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/rewear';
const esLocal = /localhost|127\.0\.0\.1/.test(connectionString);
const pool = new Pool({
  connectionString,
  // Supabase (y cualquier base en la nube) exige conexion segura; en local no.
  ssl: esLocal ? false : { rejectUnauthorized: false },
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------------------------------------------------------------------
//  Ayudantes
// ---------------------------------------------------------------------
// ah(...)  : si una ruta async falla, el error va al manejador del final (no se cae el servidor).
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// sha(...) : convierte la contrasena en una huella (hash). Nunca se guarda en texto.
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
// bad(...) : responde un error. El mensaje lo escribe el SERVIDOR; React lo muestra en rojo.
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const num = v => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------
//  Sesion y rol
// ---------------------------------------------------------------------
// Libreta en memoria: token -> usuario. Al apagar el servidor se borra (hay que reingresar).
const sesiones = new Map();

function usuarioDeToken(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  return sesiones.get(token) || null;
}
// Guardian para cualquier usuario con sesion (comprador o admin).
function requiereSesion(req, res, next) {
  const u = usuarioDeToken(req);
  if (!u) return bad(res, 'Debes iniciar sesión.', 401);
  req.user = u;
  next();
}
// Guardian solo para administradores. 401 = sin sesion, 403 = no es admin.
function soloAdmin(req, res, next) {
  const u = usuarioDeToken(req);
  if (!u) return bad(res, 'Debes iniciar sesión.', 401);
  if (u.rol !== 'admin') return bad(res, 'Solo el administrador puede hacer esto.', 403);
  req.admin = u;
  req.user = u;
  next();
}

// ---------------------------------------------------------------------
//  Servicio de valoracion (Core, Pilar 2)
// ---------------------------------------------------------------------
function calcularValor(valorBase, factor, multiplicador, verificada) {
  const estimado = Math.round(valorBase * factor * multiplicador);
  return verificada ? Math.round(estimado * 1.2) : estimado;
}
const BONO_BIENVENIDA = 10; // creditos extra por la 1.a prenda aprobada

// Tallas por grupo (la categoria trae su grupo_talla) -> dropdown dependiente
const TALLAS = {
  ropa_superior: ['XS', 'S', 'M', 'L', 'XL'],
  ropa_inferior: ['28', '30', '32', '34', '36'],
  calzado: ['37', '38', '39', '40', '41', '42'],
  accesorio: ['Única'],
};

// Saldo = suma de movimientos (los descuentos restan).
async function saldoDe(db, userId) {
  const r = await db.query(
    "SELECT COALESCE(SUM(CASE WHEN tipo='descuento' THEN -monto ELSE monto END),0)::int AS s FROM movimientos WHERE usuario_id=$1",
    [userId]);
  return r.rows[0].s;
}
// Creditos retenidos en reservas todavia abiertas.
async function reservadoDe(db, userId) {
  const r = await db.query(
    "SELECT COALESCE(SUM(monto),0)::int AS s FROM solicitudes WHERE solicitante_id=$1 AND estado IN ('reservada','enviada')",
    [userId]);
  return r.rows[0].s;
}
// Perfil de reputacion y nivel: reputacion = promedio de valoraciones recibidas;
// intercambios = reservas entregadas en las que participa; nivel = el mas alto que cumple ambos minimos.
async function perfilDe(db, userId) {
  const rep = await db.query(
    'SELECT COALESCE(AVG(puntaje),0)::real AS prom, COUNT(*)::int AS n FROM valoraciones WHERE evaluado_id=$1', [userId]);
  const inter = await db.query(
    "SELECT COUNT(*)::int AS n FROM solicitudes WHERE estado='entregada' AND (solicitante_id=$1 OR dueno_id=$1)", [userId]);
  const reputacion = Number(rep.rows[0].prom);
  const intercambios = inter.rows[0].n;
  const niveles = (await db.query('SELECT * FROM niveles ORDER BY rango DESC')).rows;
  const nivel = niveles.find(n => intercambios >= n.intercambios_min && reputacion >= n.reputacion_min)
    || niveles[niveles.length - 1];
  return { reputacion: Math.round(reputacion * 100) / 100, intercambios, nivel, n_valoraciones: rep.rows[0].n };
}

// ---------------------------------------------------------------------
//  AUTENTICACION: registro, login y sesion
// ---------------------------------------------------------------------
// Registro: crea siempre un usuario con rol 'user' y lo deja con sesion iniciada.
app.post('/api/registro', ah(async (req, res) => {
  const b = req.body || {};
  const correo = String(b.correo || '').trim().toLowerCase();
  const nombre = String(b.nombre || '').trim(), apellido = String(b.apellido || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return bad(res, 'El correo no tiene un formato válido.');
  if (nombre.length < 2 || apellido.length < 2) return bad(res, 'Nombre y apellido son obligatorios.');
  if (String(b.contrasena || '').length < 6) return bad(res, 'La contraseña debe tener al menos 6 caracteres.');
  const dup = await pool.query('SELECT 1 FROM usuarios WHERE correo=$1', [correo]);
  if (dup.rowCount) return bad(res, 'Ya existe una cuenta con ese correo.', 409);
  const ins = await pool.query(
    "INSERT INTO usuarios (correo,nombre,apellido,contrasena,rol) VALUES ($1,$2,$3,$4,'user') RETURNING id, correo, nombre, apellido, rol",
    [correo, nombre, apellido, sha(b.contrasena)]);
  const token = crypto.randomBytes(24).toString('hex');
  sesiones.set(token, ins.rows[0]);
  res.status(201).json({ token, usuario: ins.rows[0] });
}));

// Login: sirve para usuario y para admin (el rol decide que pantallas ve React).
app.post('/api/login', ah(async (req, res) => {
  const { correo, contrasena } = req.body || {};
  const r = await pool.query(
    'SELECT id, correo, nombre, apellido, rol FROM usuarios WHERE correo=$1 AND contrasena=$2',
    [String(correo || '').trim().toLowerCase(), sha(contrasena || '')]);
  if (r.rowCount === 0) return bad(res, 'Correo o contraseña incorrectos.', 401);
  const token = crypto.randomBytes(24).toString('hex');
  sesiones.set(token, r.rows[0]);
  res.json({ token, usuario: r.rows[0] });
}));

app.post('/api/logout', requiereSesion, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  sesiones.delete(token);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
//  CATALOGOS para llenar los dropdowns (los usan las dos areas)
// ---------------------------------------------------------------------
app.get('/api/catalogos', requiereSesion, ah(async (_req, res) => {
  const q = t => pool.query(t).then(r => r.rows);
  res.json({
    categorias: await q('SELECT id, nombre, valor_base, grupo_talla FROM categorias ORDER BY id'),
    estados: await q('SELECT id, nombre, factor FROM estados ORDER BY factor DESC'),
    marcas: await q('SELECT id, nombre, multiplicador FROM marcas ORDER BY nombre'),
    temporadas: await q('SELECT id, nombre FROM temporadas ORDER BY id'),
    estilos: await q('SELECT id, nombre FROM estilos ORDER BY id'),
    rarezas: await q('SELECT id, nombre, saldo_minimo FROM rarezas ORDER BY id'),
    niveles: await q('SELECT id, nombre FROM niveles ORDER BY rango'),
    usuarios: await q("SELECT id, nombre || ' ' || apellido || ' (' || correo || ')' AS nombre FROM usuarios WHERE rol='user' ORDER BY id"),
  });
}));

// Dropdown dependiente 1: categoria (padre) -> tallas (hijo), como pais -> provincia.
app.get('/api/categorias/:id/tallas', requiereSesion, ah(async (req, res) => {
  const c = await pool.query('SELECT grupo_talla FROM categorias WHERE id=$1', [Number(req.params.id)]);
  if (c.rowCount === 0) return bad(res, 'La categoría no existe.', 404);
  res.json(TALLAS[c.rows[0].grupo_talla]);
}));

// Dropdown dependiente 2: temporada + estilo (dos padres) -> drops que coinciden.
app.get('/api/colecciones/buscar', requiereSesion, ah(async (req, res) => {
  const t = Number(req.query.temporada_id), e = Number(req.query.estilo_id);
  const r = await pool.query(
    'SELECT id, nombre FROM colecciones WHERE temporada_id=$1 AND estilo_id=$2 ORDER BY nombre', [t, e]);
  res.json(r.rows);
}));

// ---------------------------------------------------------------------
//  Funcion compartida: validar y registrar una prenda (entrega).
//  La usan el usuario (entrega la suya) y el admin (la registra para un usuario).
//  Todas las claves foraneas llegan de dropdowns y el servidor las vuelve a validar.
// ---------------------------------------------------------------------
async function registrarPrenda(body, duenoId) {
  const b = body || {};
  const titulo = String(b.titulo || '').trim();
  if (titulo.length < 3 || titulo.length > 80) throw { status: 400, msg: 'El título debe tener entre 3 y 80 caracteres.' };

  const one = async (sql, p, msg) => { const r = await pool.query(sql, p); if (!r.rowCount) throw { status: 400, msg }; return r.rows[0]; };
  await one("SELECT id FROM usuarios WHERE id=$1", [duenoId], 'El usuario dueño no existe.');
  const cat = await one('SELECT id, valor_base, grupo_talla FROM categorias WHERE id=$1', [b.categoria_id], 'La categoría no existe.');
  const est = await one('SELECT id, factor FROM estados WHERE id=$1', [b.estado_id], 'El estado no existe.');
  // Marca: puede ser una de la lista, o una NUEVA escrita por el usuario.
  // La marca nueva entra con multiplicador neutro (1.0); el admin la calibra luego en Parametros.
  let marcaId, marcaMult;
  const marcaNueva = String(b.marca_nueva || '').trim();
  if (marcaNueva) {
    if (marcaNueva.length < 2 || marcaNueva.length > 40) throw { status: 400, msg: 'El nombre de la marca debe tener entre 2 y 40 caracteres.' };
    const ex = await pool.query('SELECT id, multiplicador FROM marcas WHERE lower(nombre)=lower($1)', [marcaNueva]);
    if (ex.rowCount) { marcaId = ex.rows[0].id; marcaMult = ex.rows[0].multiplicador; }
    else {
      const insM = await pool.query('INSERT INTO marcas (nombre, multiplicador) VALUES ($1, 1.0) RETURNING id, multiplicador', [marcaNueva]);
      marcaId = insM.rows[0].id; marcaMult = insM.rows[0].multiplicador;
    }
  } else {
    const mar = await one('SELECT id, multiplicador FROM marcas WHERE id=$1', [b.marca_id], 'La marca no existe.');
    marcaId = mar.id; marcaMult = mar.multiplicador;
  }
  await one('SELECT id FROM temporadas WHERE id=$1', [b.temporada_id], 'La temporada no existe.');
  await one('SELECT id FROM rarezas WHERE id=$1', [b.rareza_id], 'La rareza no existe.');

  // El servidor NO confia en el dropdown: revalida que la talla pertenezca a la categoria.
  if (!TALLAS[cat.grupo_talla].includes(String(b.talla)))
    throw { status: 400, msg: 'La talla no corresponde a la categoría seleccionada.' };

  const estilos = Array.isArray(b.estilos) ? b.estilos.map(Number) : [];
  if (estilos.length === 0) throw { status: 400, msg: 'Elige al menos un estilo.' };
  for (const eid of estilos) await one('SELECT id FROM estilos WHERE id=$1', [eid], 'Un estilo elegido no existe.');

  let coleccionId = null;
  if (b.coleccion_id) {
    const col = await one('SELECT id, temporada_id, estilo_id FROM colecciones WHERE id=$1', [b.coleccion_id], 'La colección no existe.');
    if (col.temporada_id !== Number(b.temporada_id) || !estilos.includes(col.estilo_id))
      throw { status: 400, msg: 'La colección no corresponde a la temporada/estilo elegidos.' };
    coleccionId = col.id;
  }

  // Foto (URL) y sello de exclusividad (firma / edicion): todos opcionales.
  const imagen = String(b.imagen || '').trim();
  if (imagen && !/^https?:\/\/.+/i.test(imagen)) throw { status: 400, msg: 'La foto debe ser un enlace que empiece con http:// o https://' };
  const firma = String(b.firma || '').trim().slice(0, 80) || null;
  const edicion = String(b.edicion || '').trim().slice(0, 40) || null;

  // El valor estimado lo calcula el servidor (nunca el navegador).
  const valor = calcularValor(cat.valor_base, est.factor, marcaMult, false);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO prendas (dueno_id,categoria_id,estado_id,marca_id,coleccion_id,temporada_id,rareza_id,titulo,talla,color,valor,imagen,firma,edicion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, valor, estado`,
      [duenoId, cat.id, est.id, marcaId, coleccionId, b.temporada_id, b.rareza_id, titulo, String(b.talla),
       String(b.color || '').slice(0, 30) || null, valor, imagen || null, firma, edicion]);
    for (const eid of estilos)
      await client.query('INSERT INTO prenda_estilo (prenda_id, estilo_id) VALUES ($1,$2)', [ins.rows[0].id, eid]);
    await client.query('COMMIT');
    return ins.rows[0];
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// =====================================================================
//  AREA DE USUARIO
// =====================================================================

// Panel: saldo, creditos reservados, nivel, reputacion y escalera de rarezas.
app.get('/api/mi/panel', requiereSesion, ah(async (req, res) => {
  const saldo = await saldoDe(pool, req.user.id);
  const reservado = await reservadoDe(pool, req.user.id);
  const perfil = await perfilDe(pool, req.user.id);
  const rarezas = (await pool.query('SELECT id, nombre, saldo_minimo FROM rarezas ORDER BY saldo_minimo')).rows
    .map(r => ({ ...r, desbloqueada: saldo >= r.saldo_minimo }));
  const mis = await pool.query(
    "SELECT COUNT(*) FILTER (WHERE estado='disponible')::int AS en_stock, COUNT(*) FILTER (WHERE estado='en_revision')::int AS en_revision FROM prendas WHERE dueno_id=$1",
    [req.user.id]);
  res.json({ usuario: req.user, saldo, reservado, ...perfil, rarezas, mis_prendas: mis.rows[0] });
}));

// Catalogo: prendas disponibles de otros usuarios, con filtros. Marca cuales puedo reservar.
app.get('/api/catalogo', requiereSesion, ah(async (req, res) => {
  const saldo = await saldoDe(pool, req.user.id);
  // El catalogo NO incluye las piezas exclusivas de drops (esas solo viven en su drop).
  const cond = ["p.estado='disponible'", 'p.dueno_id<>$1', 'p.coleccion_id IS NULL'];
  const args = [req.user.id];
  const add = (sql, val) => { args.push(val); cond.push(sql.replace('?', '$' + args.length)); };
  if (req.query.temporada_id) add('p.temporada_id=?', Number(req.query.temporada_id));
  if (req.query.rareza_id) add('p.rareza_id=?', Number(req.query.rareza_id));
  if (req.query.talla) add('p.talla=?', String(req.query.talla));
  if (req.query.verificada === 'true') cond.push('p.verificada=true');
  if (req.query.estilo_id) add('EXISTS (SELECT 1 FROM prenda_estilo pe WHERE pe.prenda_id=p.id AND pe.estilo_id=?)', Number(req.query.estilo_id));

  const r = await pool.query(`
    SELECT p.id, p.titulo, p.talla, p.color, p.valor, p.verificada, p.imagen,
           c.nombre AS categoria, m.nombre AS marca, t.nombre AS temporada,
           ra.nombre AS rareza, ra.saldo_minimo,
           u.nombre || ' ' || u.apellido AS dueno,
           COALESCE((SELECT string_agg(e.nombre, ', ') FROM prenda_estilo pe JOIN estilos e ON e.id=pe.estilo_id WHERE pe.prenda_id=p.id),'') AS estilos
    FROM prendas p
    JOIN categorias c ON c.id=p.categoria_id
    JOIN marcas m ON m.id=p.marca_id
    JOIN temporadas t ON t.id=p.temporada_id
    JOIN rarezas ra ON ra.id=p.rareza_id
    JOIN usuarios u ON u.id=p.dueno_id
    WHERE ${cond.join(' AND ')}
    ORDER BY p.id DESC`, args);

  const prendas = r.rows.map(p => ({
    ...p,
    bloqueada: saldo < p.saldo_minimo,           // rareza bloqueada por saldo
    sin_saldo: saldo < p.valor,                  // no alcanza para pagarla
    puedo_reservar: saldo >= p.saldo_minimo && saldo >= p.valor,
  }));
  res.json({ saldo, prendas });
}));

// Detalle de una prenda, con el desglose de como se calcula su valor.
app.get('/api/prendas/:id', requiereSesion, ah(async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query(`
    SELECT p.id, p.titulo, p.talla, p.color, p.valor, p.verificada, p.estado, p.dueno_id,
           p.imagen, p.firma, p.edicion,
           c.nombre AS categoria, c.valor_base, e.nombre AS estado_prenda, e.factor,
           m.nombre AS marca, m.multiplicador, t.nombre AS temporada,
           ra.nombre AS rareza, ra.saldo_minimo,
           u.nombre || ' ' || u.apellido AS dueno,
           COALESCE((SELECT string_agg(es.nombre, ', ') FROM prenda_estilo pe JOIN estilos es ON es.id=pe.estilo_id WHERE pe.prenda_id=p.id),'') AS estilos
    FROM prendas p
    JOIN categorias c ON c.id=p.categoria_id
    JOIN estados e ON e.id=p.estado_id
    JOIN marcas m ON m.id=p.marca_id
    JOIN temporadas t ON t.id=p.temporada_id
    JOIN rarezas ra ON ra.id=p.rareza_id
    JOIN usuarios u ON u.id=p.dueno_id
    WHERE p.id=$1`, [id]);
  if (r.rowCount === 0) return bad(res, 'La prenda no existe.', 404);
  const saldo = await saldoDe(pool, req.user.id);
  const p = r.rows[0];
  res.json({
    ...p,
    es_mia: p.dueno_id === req.user.id,
    saldo,
    bloqueada: saldo < p.saldo_minimo,
    sin_saldo: saldo < p.valor,
    puedo_reservar: p.estado === 'disponible' && p.dueno_id !== req.user.id
      && saldo >= p.saldo_minimo && saldo >= p.valor,
  });
}));

// Entregar una prenda: queda EN REVISION hasta que el admin la valide.
app.post('/api/prendas', requiereSesion, ah(async (req, res) => {
  try {
    const prenda = await registrarPrenda(req.body, req.user.id);
    res.status(201).json(prenda);
  } catch (e) { if (e && e.status) return bad(res, e.msg, e.status); throw e; }
}));

// Mis prendas entregadas (y su estado dentro del ciclo).
app.get('/api/mis-prendas', requiereSesion, ah(async (req, res) => {
  const r = await pool.query(`
    SELECT p.id, p.titulo, p.talla, p.valor, p.estado, p.verificada,
           c.nombre AS categoria, ra.nombre AS rareza
    FROM prendas p JOIN categorias c ON c.id=p.categoria_id JOIN rarezas ra ON ra.id=p.rareza_id
    WHERE p.dueno_id=$1 ORDER BY p.id DESC`, [req.user.id]);
  res.json(r.rows);
}));

// RESERVAR: retiene los creditos en una transaccion para evitar el doble gasto.
app.post('/api/prendas/:id/reservar', requiereSesion, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return bad(res, 'Prenda inválida.');
  // Metodo de entrega elegido por el comprador: retiro en punto o envio a domicilio.
  const metodo = (req.body || {}).metodo_entrega === 'envio' ? 'envio' : 'retiro';
  const direccion = metodo === 'envio' ? String((req.body || {}).direccion || '').trim() : null;
  if (metodo === 'envio' && direccion.length < 5) return bad(res, 'Escribe una dirección de envío válida.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Bloquea la prenda mientras decidimos, para que dos personas no la reserven a la vez.
    const pr = await client.query('SELECT * FROM prendas WHERE id=$1 FOR UPDATE', [id]);
    if (pr.rowCount === 0) { await client.query('ROLLBACK'); return bad(res, 'La prenda no existe.', 404); }
    const prenda = pr.rows[0];
    if (prenda.estado !== 'disponible') { await client.query('ROLLBACK'); return bad(res, 'Esta prenda ya no está disponible.', 409); }
    if (prenda.dueno_id === req.user.id) { await client.query('ROLLBACK'); return bad(res, 'No puedes reservar tu propia prenda.'); }

    // Si la prenda es EXCLUSIVA de un drop, se valida el nivel y la vigencia del drop.
    if (prenda.coleccion_id) {
      const col = (await client.query(
        `SELECT n.rango AS rango_min, n.nombre AS nivel_min, c.nombre,
                (CURRENT_DATE BETWEEN c.inicia_en AND c.termina_en) AS vigente
         FROM colecciones c JOIN niveles n ON n.id=c.nivel_min_id WHERE c.id=$1`, [prenda.coleccion_id])).rows[0];
      if (!col.vigente) { await client.query('ROLLBACK'); return bad(res, 'Este drop ya no está vigente.'); }
      const perfil = await perfilDe(client, req.user.id);
      if (perfil.nivel.rango < col.rango_min) {
        await client.query('ROLLBACK');
        return bad(res, `Esta pieza es exclusiva del drop "${col.nombre}". Necesitas nivel ${col.nivel_min} para reservarla.`);
      }
    }

    const rar = (await client.query('SELECT saldo_minimo, nombre FROM rarezas WHERE id=$1', [prenda.rareza_id])).rows[0];
    const saldo = await saldoDe(client, req.user.id);
    if (saldo < rar.saldo_minimo) { await client.query('ROLLBACK'); return bad(res, `Necesitas al menos ${rar.saldo_minimo} créditos para desbloquear prendas ${rar.nombre}.`); }
    if (saldo < prenda.valor) { await client.query('ROLLBACK'); return bad(res, `No te alcanza el saldo: la prenda cuesta ${prenda.valor} y tienes ${saldo}.`); }

    const sol = await client.query(
      "INSERT INTO solicitudes (prenda_id, solicitante_id, dueno_id, monto, metodo_entrega, direccion, estado) VALUES ($1,$2,$3,$4,$5,$6,'reservada') RETURNING id",
      [id, req.user.id, prenda.dueno_id, prenda.valor, metodo, direccion]);
    // Se retienen los creditos del comprador (descuento) y la prenda pasa a reservada.
    await client.query(
      "INSERT INTO movimientos (usuario_id, solicitud_id, prenda_id, tipo, monto) VALUES ($1,$2,$3,'descuento',$4)",
      [req.user.id, sol.rows[0].id, id, prenda.valor]);
    await client.query("UPDATE prendas SET estado='reservada' WHERE id=$1", [id]);
    await client.query('COMMIT');
    res.status(201).json({ solicitud_id: sol.rows[0].id, retenido: prenda.valor, saldo_restante: saldo - prenda.valor });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

// Mis reservas (para confirmar la recepcion y valorar).
app.get('/api/mis-reservas', requiereSesion, ah(async (req, res) => {
  const r = await pool.query(`
    SELECT s.id, s.monto, s.estado, s.metodo_entrega, s.direccion, p.titulo, p.talla, ra.nombre AS rareza,
           du.nombre || ' ' || du.apellido AS dueno,
           EXISTS (SELECT 1 FROM valoraciones v WHERE v.solicitud_id=s.id) AS valorada
    FROM solicitudes s
    JOIN prendas p ON p.id=s.prenda_id
    JOIN rarezas ra ON ra.id=p.rareza_id
    JOIN usuarios du ON du.id=s.dueno_id
    WHERE s.solicitante_id=$1 ORDER BY s.id DESC`, [req.user.id]);
  res.json(r.rows);
}));

// CONFIRMAR RECEPCION: transfiere los creditos retenidos al dueno, en una sola transaccion.
app.post('/api/solicitudes/:id/confirmar', requiereSesion, ah(async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await client.query('SELECT * FROM solicitudes WHERE id=$1 FOR UPDATE', [id]);
    if (s.rowCount === 0) { await client.query('ROLLBACK'); return bad(res, 'La reserva no existe.', 404); }
    const sol = s.rows[0];
    if (sol.solicitante_id !== req.user.id) { await client.query('ROLLBACK'); return bad(res, 'Esta reserva no es tuya.', 403); }
    if (sol.estado !== 'enviada') { await client.query('ROLLBACK'); return bad(res, 'Solo puedes confirmar cuando el dueño haya marcado la prenda como enviada/entregada.', 409); }

    // El dueno recibe los creditos; la prenda y la reserva quedan entregadas.
    await client.query(
      "INSERT INTO movimientos (usuario_id, solicitud_id, prenda_id, tipo, monto) VALUES ($1,$2,$3,'abono',$4)",
      [sol.dueno_id, id, sol.prenda_id, sol.monto]);
    await client.query("UPDATE prendas SET estado='entregada' WHERE id=$1", [sol.prenda_id]);
    await client.query("UPDATE solicitudes SET estado='entregada', completado_en=now() WHERE id=$1", [id]);
    await client.query('COMMIT');
    res.json({ ok: true, transferido: sol.monto });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

// El DUENO marca la prenda como enviada/entregada al comprador (paso intermedio del proceso).
app.post('/api/solicitudes/:id/enviar', requiereSesion, ah(async (req, res) => {
  const id = Number(req.params.id);
  const s = await pool.query('SELECT * FROM solicitudes WHERE id=$1', [id]);
  if (s.rowCount === 0) return bad(res, 'La reserva no existe.', 404);
  const sol = s.rows[0];
  if (sol.dueno_id !== req.user.id) return bad(res, 'Solo el dueño puede marcar el envío.', 403);
  if (sol.estado !== 'reservada') return bad(res, 'Esta reserva ya no está en estado reservada.', 409);
  await pool.query("UPDATE solicitudes SET estado='enviada' WHERE id=$1", [id]);
  res.json({ ok: true });
}));

// CANCELAR: el comprador o el dueno, antes de entregar. Devuelve los creditos (reembolso) y libera la prenda.
app.post('/api/solicitudes/:id/cancelar', requiereSesion, ah(async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await client.query('SELECT * FROM solicitudes WHERE id=$1 FOR UPDATE', [id]);
    if (s.rowCount === 0) { await client.query('ROLLBACK'); return bad(res, 'La reserva no existe.', 404); }
    const sol = s.rows[0];
    if (sol.solicitante_id !== req.user.id && sol.dueno_id !== req.user.id) { await client.query('ROLLBACK'); return bad(res, 'Esta reserva no es tuya.', 403); }
    if (!['reservada', 'enviada'].includes(sol.estado)) { await client.query('ROLLBACK'); return bad(res, 'Esta reserva ya no se puede cancelar.', 409); }
    // Se devuelven los creditos retenidos al comprador y la prenda vuelve a disponible.
    await client.query(
      "INSERT INTO movimientos (usuario_id, solicitud_id, prenda_id, tipo, monto) VALUES ($1,$2,$3,'reembolso',$4)",
      [sol.solicitante_id, id, sol.prenda_id, sol.monto]);
    await client.query("UPDATE prendas SET estado='disponible' WHERE id=$1", [sol.prenda_id]);
    await client.query("UPDATE solicitudes SET estado='cancelada' WHERE id=$1", [id]);
    await client.query('COMMIT');
    res.json({ ok: true, reembolsado: sol.monto });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

// Ventas: reservas sobre MIS prendas (donde soy el dueno), para gestionar la entrega.
app.get('/api/mis-ventas', requiereSesion, ah(async (req, res) => {
  const r = await pool.query(`
    SELECT s.id, s.monto, s.estado, s.metodo_entrega, s.direccion, p.titulo, p.talla,
           co.nombre || ' ' || co.apellido AS comprador
    FROM solicitudes s
    JOIN prendas p ON p.id=s.prenda_id
    JOIN usuarios co ON co.id=s.solicitante_id
    WHERE s.dueno_id=$1 ORDER BY s.id DESC`, [req.user.id]);
  res.json(r.rows);
}));

// Chat de una reserva: solo el comprador y el dueno pueden ver y escribir.
async function parteDeSolicitud(id, userId) {
  const s = await pool.query('SELECT solicitante_id, dueno_id FROM solicitudes WHERE id=$1', [id]);
  if (s.rowCount === 0) return null;
  const sol = s.rows[0];
  return (sol.solicitante_id === userId || sol.dueno_id === userId) ? sol : false;
}
app.get('/api/solicitudes/:id/mensajes', requiereSesion, ah(async (req, res) => {
  const id = Number(req.params.id);
  const ok = await parteDeSolicitud(id, req.user.id);
  if (ok === null) return bad(res, 'La reserva no existe.', 404);
  if (ok === false) return bad(res, 'No puedes ver este chat.', 403);
  const r = await pool.query(`
    SELECT m.id, m.texto, m.emisor_id, to_char(m.creado_en,'YYYY-MM-DD HH24:MI') AS fecha, u.nombre AS emisor
    FROM mensajes m JOIN usuarios u ON u.id=m.emisor_id
    WHERE m.solicitud_id=$1 ORDER BY m.id`, [id]);
  res.json({ yo: req.user.id, mensajes: r.rows });
}));
app.post('/api/solicitudes/:id/mensajes', requiereSesion, ah(async (req, res) => {
  const id = Number(req.params.id);
  const texto = String((req.body || {}).texto || '').trim();
  if (!texto) return bad(res, 'Escribe un mensaje.');
  if (texto.length > 500) return bad(res, 'El mensaje es muy largo (máximo 500).');
  const ok = await parteDeSolicitud(id, req.user.id);
  if (ok === null) return bad(res, 'La reserva no existe.', 404);
  if (ok === false) return bad(res, 'No puedes escribir en este chat.', 403);
  await pool.query('INSERT INTO mensajes (solicitud_id, emisor_id, texto) VALUES ($1,$2,$3)', [id, req.user.id, texto]);
  res.status(201).json({ ok: true });
}));

// Valorar la experiencia (1 a 5) despues de confirmar.
app.post('/api/solicitudes/:id/valorar', requiereSesion, ah(async (req, res) => {
  const id = Number(req.params.id);
  const puntaje = Number((req.body || {}).puntaje);
  const comentario = String((req.body || {}).comentario || '').slice(0, 300) || null;
  if (!Number.isInteger(puntaje) || puntaje < 1 || puntaje > 5) return bad(res, 'El puntaje debe ser un número del 1 al 5.');
  const s = await pool.query('SELECT * FROM solicitudes WHERE id=$1', [id]);
  if (s.rowCount === 0) return bad(res, 'La reserva no existe.', 404);
  const sol = s.rows[0];
  if (sol.solicitante_id !== req.user.id) return bad(res, 'Esta reserva no es tuya.', 403);
  if (sol.estado !== 'entregada') return bad(res, 'Solo puedes valorar una reserva ya confirmada.');
  const dup = await pool.query('SELECT 1 FROM valoraciones WHERE solicitud_id=$1', [id]);
  if (dup.rowCount) return bad(res, 'Ya valoraste esta reserva.', 409);
  await pool.query(
    'INSERT INTO valoraciones (solicitud_id, evaluador_id, evaluado_id, puntaje, comentario) VALUES ($1,$2,$3,$4,$5)',
    [id, req.user.id, sol.dueno_id, puntaje, comentario]);
  res.status(201).json({ ok: true });
}));

// Billetera: saldo, reservado y lista de movimientos.
app.get('/api/billetera', requiereSesion, ah(async (req, res) => {
  const saldo = await saldoDe(pool, req.user.id);
  const reservado = await reservadoDe(pool, req.user.id);
  const movs = await pool.query(`
    SELECT m.id, m.tipo, m.monto, to_char(m.creado_en,'YYYY-MM-DD HH24:MI') AS fecha, p.titulo AS prenda
    FROM movimientos m LEFT JOIN prendas p ON p.id=m.prenda_id
    WHERE m.usuario_id=$1 ORDER BY m.id DESC`, [req.user.id]);
  res.json({ saldo, reservado, movimientos: movs.rows });
}));

// Drops vigentes a los que llego por mi nivel, con sus prendas disponibles.
app.get('/api/drops', requiereSesion, ah(async (req, res) => {
  const perfil = await perfilDe(pool, req.user.id);
  const cols = await pool.query(`
    SELECT c.id, c.nombre, n.nombre AS nivel_min, n.rango AS rango_min, t.nombre AS temporada, e.nombre AS estilo,
           to_char(c.inicia_en,'YYYY-MM-DD') AS inicia_en, to_char(c.termina_en,'YYYY-MM-DD') AS termina_en,
           (CURRENT_DATE BETWEEN c.inicia_en AND c.termina_en) AS vigente
    FROM colecciones c JOIN niveles n ON n.id=c.nivel_min_id
    JOIN temporadas t ON t.id=c.temporada_id JOIN estilos e ON e.id=c.estilo_id
    ORDER BY c.id`);
  const drops = [];
  for (const c of cols.rows) {
    const accesible = perfil.nivel.rango >= c.rango_min && c.vigente;
    const prendas = accesible ? (await pool.query(
      "SELECT p.id, p.titulo, p.valor, p.talla, p.imagen, p.firma, p.edicion, ra.nombre AS rareza FROM prendas p JOIN rarezas ra ON ra.id=p.rareza_id WHERE p.coleccion_id=$1 AND p.estado='disponible' ORDER BY p.id", [c.id])).rows : [];
    drops.push({ ...c, accesible, prendas });
  }
  res.json({ nivel: perfil.nivel, drops });
}));

// =====================================================================
//  AREA DE ADMINISTRACION (modulo del Core que ya tenias)
// =====================================================================

// Admin "Registrar": la plataforma da de alta piezas propias (drops / exclusivas)
// o recibe ropa en un punto fisico (intake). No es para gestionar el closet de nadie;
// el flujo normal de un usuario es POST /api/prendas ("Entregar").
app.post('/api/admin/prendas', soloAdmin, ah(async (req, res) => {
  try {
    const prenda = await registrarPrenda(req.body, Number(req.body.dueno_id));
    res.status(201).json(prenda);
  } catch (e) { if (e && e.status) return bad(res, e.msg, e.status); throw e; }
}));

// Lista de prendas por estado (por defecto, las que estan en revision).
app.get('/api/admin/prendas', soloAdmin, ah(async (req, res) => {
  const estado = req.query.estado || 'en_revision';
  const r = await pool.query(`
    SELECT p.id, p.titulo, p.talla, p.valor, p.estado, p.verificada,
           u.nombre || ' ' || u.apellido AS dueno,
           c.nombre AS categoria, e.nombre AS estado_declarado, e.id AS estado_id,
           m.nombre AS marca, ra.nombre AS rareza, ra.id AS rareza_id
    FROM prendas p
    JOIN usuarios u ON u.id = p.dueno_id
    JOIN categorias c ON c.id = p.categoria_id
    JOIN estados e ON e.id = p.estado_id
    JOIN marcas m ON m.id = p.marca_id
    JOIN rarezas ra ON ra.id = p.rareza_id
    WHERE p.estado = $1 ORDER BY p.id`, [estado]);
  res.json(r.rows);
}));

// *** REQUISITO 1: validacion en el back-end de un dato sensible (CREDITOS) ***
app.post('/api/admin/prendas/:id/validar', soloAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const { resultado, estado_id, rareza_id, autentica, notas } = req.body || {};
  if (!Number.isInteger(id)) return bad(res, 'Prenda inválida.');
  if (!['aprobada', 'rechazada'].includes(resultado)) return bad(res, 'El resultado debe ser aprobada o rechazada.');
  if (typeof autentica !== 'boolean') return bad(res, 'Indica si la prenda es auténtica (sí/no).');
  if (notas != null && String(notas).length > 300) return bad(res, 'Las notas no pueden superar 300 caracteres.');
  if (resultado === 'rechazada' && autentica) return bad(res, 'Una prenda rechazada no puede marcarse como auténtica.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pr = await client.query('SELECT * FROM prendas WHERE id=$1 FOR UPDATE', [id]);
    if (pr.rowCount === 0) { await client.query('ROLLBACK'); return bad(res, 'La prenda no existe.', 404); }
    const prenda = pr.rows[0];
    if (prenda.estado !== 'en_revision') {
      await client.query('ROLLBACK');
      return bad(res, `La prenda ya fue procesada (estado: ${prenda.estado}). No se abonan créditos dos veces.`, 409);
    }

    let valorFinal = 0, abono = 0, bono = 0;
    if (resultado === 'aprobada') {
      const est = await client.query('SELECT factor FROM estados WHERE id=$1', [estado_id]);
      if (est.rowCount === 0) { await client.query('ROLLBACK'); return bad(res, 'El estado real elegido no existe.'); }
      const rar = await client.query('SELECT id FROM rarezas WHERE id=$1', [rareza_id]);
      if (rar.rowCount === 0) { await client.query('ROLLBACK'); return bad(res, 'La rareza elegida no existe.'); }
      const cat = await client.query('SELECT valor_base FROM categorias WHERE id=$1', [prenda.categoria_id]);
      const mar = await client.query('SELECT multiplicador FROM marcas WHERE id=$1', [prenda.marca_id]);

      // Los 3 numeros salen de las TABLAS, no del navegador. Nadie puede regalarse creditos.
      valorFinal = calcularValor(cat.rows[0].valor_base, est.rows[0].factor, mar.rows[0].multiplicador, autentica);
      abono = valorFinal;
      await client.query(
        "UPDATE prendas SET estado='disponible', estado_id=$1, rareza_id=$2, verificada=$3, valor=$4 WHERE id=$5",
        [estado_id, rareza_id, autentica, valorFinal, id]);
      await client.query(
        "INSERT INTO movimientos (usuario_id, prenda_id, tipo, monto) VALUES ($1,$2,'abono',$3)", [prenda.dueno_id, id, abono]);

      // Bono de bienvenida: solo la 1.a prenda aprobada del usuario.
      const previas = await client.query(
        "SELECT count(*)::int AS n FROM prendas WHERE dueno_id=$1 AND id<>$2 AND estado IN ('disponible','reservada','entregada')",
        [prenda.dueno_id, id]);
      if (previas.rows[0].n === 0) {
        bono = BONO_BIENVENIDA;
        await client.query("INSERT INTO movimientos (usuario_id, tipo, monto) VALUES ($1,'bono',$2)", [prenda.dueno_id, bono]);
      }
    } else {
      await client.query("UPDATE prendas SET estado='retirada' WHERE id=$1", [id]);
    }

    await client.query(
      'INSERT INTO verificaciones (prenda_id, admin_id, estado, notas) VALUES ($1,$2,$3,$4)',
      [id, req.admin.id, resultado, notas ? String(notas).trim() : null]);
    await client.query('COMMIT');
    res.json({
      prenda_id: id, resultado,
      estado_prenda: resultado === 'aprobada' ? 'disponible' : 'retirada',
      valor_final: valorFinal, creditos_abonados: abono, bono_bienvenida: bono,
    });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

// *** REQUISITO 1 (segunda validacion): parametros del Core ***
const PARAMETROS = {
  rarezas:    { campo: 'saldo_minimo',  validar: v => (Number.isInteger(v) && v >= 0) ? null : 'El saldo mínimo debe ser un entero mayor o igual a 0.' },
  estados:    { campo: 'factor',        validar: v => (num(v) && v >= 0 && v <= 1) ? null : 'El factor del estado debe estar entre 0 y 1.' },
  marcas:     { campo: 'multiplicador', validar: v => (num(v) && v > 0 && v <= 5) ? null : 'El multiplicador debe ser mayor que 0 y como máximo 5.' },
  categorias: { campo: 'valor_base',    validar: v => (Number.isInteger(v) && v > 0 && v <= 1000) ? null : 'El valor base debe ser un entero entre 1 y 1000.' },
};
app.put('/api/admin/parametros/:tabla/:id', soloAdmin, ah(async (req, res) => {
  const p = PARAMETROS[req.params.tabla];            // lista blanca: evita inyeccion en el nombre de tabla
  if (!p) return bad(res, 'Parámetro desconocido.', 404);
  const id = Number(req.params.id);
  const valor = req.body ? req.body.valor : undefined;
  const err = p.validar(valor);
  if (err) return bad(res, err);
  const existe = await pool.query(`SELECT id FROM ${req.params.tabla} WHERE id=$1`, [id]);
  if (existe.rowCount === 0) return bad(res, 'El registro no existe.', 404);
  if (req.params.tabla === 'rarezas') {              // Comun < Raro < Epico < Legendario
    const all = (await pool.query('SELECT id, nombre, saldo_minimo FROM rarezas ORDER BY id')).rows;
    const i = all.findIndex(r => r.id === id);
    const ant = all[i - 1], sig = all[i + 1];
    if (ant && valor <= ant.saldo_minimo) return bad(res, `El saldo (${valor}) debe ser MAYOR que el de ${ant.nombre} (${ant.saldo_minimo}).`);
    if (sig && valor >= sig.saldo_minimo) return bad(res, `El saldo (${valor}) debe ser MENOR que el de ${sig.nombre} (${sig.saldo_minimo}).`);
  }
  const upd = await pool.query(
    `UPDATE ${req.params.tabla} SET ${p.campo}=$1 WHERE id=$2 RETURNING id, ${p.campo} AS valor`, [valor, id]);
  res.json(upd.rows[0]);
}));

// Admin: Drops (colecciones exclusivas).
app.get('/api/admin/colecciones', soloAdmin, ah(async (_req, res) => {
  const r = await pool.query(`
    SELECT c.id, c.nombre, n.nombre AS nivel_min, t.nombre AS temporada, e.nombre AS estilo,
           to_char(c.inicia_en,'YYYY-MM-DD') AS inicia_en, to_char(c.termina_en,'YYYY-MM-DD') AS termina_en
    FROM colecciones c JOIN niveles n ON n.id=c.nivel_min_id
    JOIN temporadas t ON t.id=c.temporada_id JOIN estilos e ON e.id=c.estilo_id ORDER BY c.id DESC`);
  res.json(r.rows);
}));
app.post('/api/admin/colecciones', soloAdmin, ah(async (req, res) => {
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim();
  if (nombre.length < 3 || nombre.length > 60) return bad(res, 'El nombre debe tener entre 3 y 60 caracteres.');
  const f = /^\d{4}-\d{2}-\d{2}$/;
  if (!f.test(b.inicia_en || '') || !f.test(b.termina_en || '') || isNaN(Date.parse(b.inicia_en)) || isNaN(Date.parse(b.termina_en)))
    return bad(res, 'Las fechas deben tener formato AAAA-MM-DD.');
  if (b.termina_en < b.inicia_en) return bad(res, 'La fecha de fin no puede ser anterior a la de inicio.');
  for (const [tabla, campo, msg] of [['niveles', 'nivel_min_id', 'El nivel mínimo no existe.'],
       ['temporadas', 'temporada_id', 'La temporada no existe.'], ['estilos', 'estilo_id', 'El estilo no existe.']]) {
    const r = await pool.query(`SELECT id FROM ${tabla} WHERE id=$1`, [b[campo]]);
    if (r.rowCount === 0) return bad(res, msg);
  }
  const ins = await pool.query(
    `INSERT INTO colecciones (nombre,nivel_min_id,temporada_id,estilo_id,inicia_en,termina_en)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, nombre`,
    [nombre, b.nivel_min_id, b.temporada_id, b.estilo_id, b.inicia_en, b.termina_en]);
  res.status(201).json(ins.rows[0]);
}));

// Admin: Usuarios (solo consulta) + saldo. Los usuarios se registran solos en /api/registro.
app.get('/api/admin/usuarios', soloAdmin, ah(async (_req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.correo, u.nombre, u.apellido, u.rol,
           COALESCE(SUM(CASE WHEN m.tipo='descuento' THEN -m.monto ELSE m.monto END),0)::int AS saldo
    FROM usuarios u LEFT JOIN movimientos m ON m.usuario_id=u.id
    GROUP BY u.id ORDER BY u.id`);
  res.json(r.rows);
}));

// Errores no esperados (ej. base caida).
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ReWear Market -> http://localhost:${PORT}`));
