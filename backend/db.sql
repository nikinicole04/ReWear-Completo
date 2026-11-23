-- ReWear Market - Plataforma completa (usuario + administracion)
-- Base de datos PostgreSQL. Funciona igual en Postgres local o en Supabase.
--
-- Como cargarlo:
--   Local:    psql -U postgres -d rewear -f backend/db.sql
--   Supabase: copia este archivo en el editor SQL del proyecto y ejecutalo.
--
-- 16 tablas: catalogos/parametros, usuarios, colecciones (drops), prendas,
-- prenda_estilo, solicitudes (reservas), mensajes (chat), verificaciones,
-- valoraciones y movimientos.

DROP TABLE IF EXISTS mensajes, movimientos, valoraciones, verificaciones, solicitudes,
  prenda_estilo, prendas, colecciones, usuarios, marcas, estados, categorias,
  rarezas, temporadas, estilos, niveles CASCADE;

-- ===================== CATALOGOS Y PARAMETROS =====================
CREATE TABLE niveles (
  id SERIAL PRIMARY KEY,
  codigo TEXT UNIQUE NOT NULL,
  nombre TEXT UNIQUE NOT NULL,
  rango INTEGER NOT NULL,
  intercambios_min INTEGER NOT NULL DEFAULT 0,
  reputacion_min REAL NOT NULL DEFAULT 0
);
CREATE TABLE estilos (
  id SERIAL PRIMARY KEY,
  codigo TEXT UNIQUE NOT NULL,
  nombre TEXT UNIQUE NOT NULL,
  tipo TEXT NOT NULL                        -- 'epoca' | 'estilo'
);
CREATE TABLE temporadas (
  id SERIAL PRIMARY KEY,
  codigo TEXT UNIQUE NOT NULL,
  nombre TEXT UNIQUE NOT NULL
);
CREATE TABLE rarezas (
  id SERIAL PRIMARY KEY,
  codigo TEXT UNIQUE NOT NULL,
  nombre TEXT UNIQUE NOT NULL,
  saldo_minimo INTEGER NOT NULL CHECK (saldo_minimo >= 0)
);
CREATE TABLE categorias (
  id SERIAL PRIMARY KEY,
  codigo TEXT UNIQUE NOT NULL,
  nombre TEXT UNIQUE NOT NULL,
  valor_base INTEGER NOT NULL CHECK (valor_base > 0),
  grupo_talla TEXT NOT NULL                 -- ropa_superior | ropa_inferior | calzado
);
CREATE TABLE estados (
  id SERIAL PRIMARY KEY,
  codigo TEXT UNIQUE NOT NULL,
  nombre TEXT UNIQUE NOT NULL,
  factor REAL NOT NULL CHECK (factor >= 0 AND factor <= 1)
);
CREATE TABLE marcas (
  id SERIAL PRIMARY KEY,
  nombre TEXT UNIQUE NOT NULL,
  multiplicador REAL NOT NULL CHECK (multiplicador > 0)
);

-- ===================== USUARIOS =====================
CREATE TABLE usuarios (
  id SERIAL PRIMARY KEY,
  correo TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL,
  contrasena TEXT NOT NULL,                 -- hash SHA-256 (demo)
  rol TEXT NOT NULL CHECK (rol IN ('admin','user')),
  creado_en TIMESTAMP NOT NULL DEFAULT now()
);

-- ===================== DROPS (colecciones exclusivas) =====================
CREATE TABLE colecciones (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  nivel_min_id INTEGER NOT NULL REFERENCES niveles(id),
  temporada_id INTEGER NOT NULL REFERENCES temporadas(id),
  estilo_id INTEGER NOT NULL REFERENCES estilos(id),
  inicia_en DATE NOT NULL,
  termina_en DATE NOT NULL,
  CHECK (termina_en >= inicia_en)
);

-- ===================== PRENDAS =====================
CREATE TABLE prendas (
  id SERIAL PRIMARY KEY,
  dueno_id INTEGER NOT NULL REFERENCES usuarios(id),
  categoria_id INTEGER NOT NULL REFERENCES categorias(id),
  estado_id INTEGER NOT NULL REFERENCES estados(id),
  marca_id INTEGER NOT NULL REFERENCES marcas(id),
  coleccion_id INTEGER REFERENCES colecciones(id),
  temporada_id INTEGER NOT NULL REFERENCES temporadas(id),
  rareza_id INTEGER NOT NULL REFERENCES rarezas(id),
  titulo TEXT NOT NULL,
  talla TEXT NOT NULL,
  color TEXT,
  imagen TEXT,                              -- URL de la foto de la prenda (opcional)
  firma TEXT,                               -- autor/firma de una pieza exclusiva (drops)
  edicion TEXT,                             -- numero de edicion, p.ej. "1 de 1"
  valor INTEGER NOT NULL DEFAULT 0,
  verificada BOOLEAN NOT NULL DEFAULT false,
  estado TEXT NOT NULL DEFAULT 'en_revision'
    CHECK (estado IN ('en_revision','disponible','reservada','entregada','retirada')),
  creado_en TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE prenda_estilo (
  prenda_id INTEGER NOT NULL REFERENCES prendas(id) ON DELETE CASCADE,
  estilo_id INTEGER NOT NULL REFERENCES estilos(id),
  PRIMARY KEY (prenda_id, estilo_id)
);

-- ===================== RESERVAS, VERIFICACIONES, VALORACIONES, CREDITOS =====================
CREATE TABLE solicitudes (
  id SERIAL PRIMARY KEY,
  prenda_id INTEGER NOT NULL REFERENCES prendas(id),
  solicitante_id INTEGER NOT NULL REFERENCES usuarios(id),
  dueno_id INTEGER NOT NULL REFERENCES usuarios(id),
  monto INTEGER NOT NULL DEFAULT 0,         -- creditos retenidos al reservar
  metodo_entrega TEXT NOT NULL DEFAULT 'retiro' CHECK (metodo_entrega IN ('retiro','envio')),
  direccion TEXT,                           -- solo si es envio a domicilio
  estado TEXT NOT NULL DEFAULT 'reservada'
    CHECK (estado IN ('reservada','enviada','entregada','cancelada')),
  creado_en TIMESTAMP NOT NULL DEFAULT now(),
  completado_en TIMESTAMP
);
CREATE TABLE verificaciones (
  id SERIAL PRIMARY KEY,
  prenda_id INTEGER NOT NULL REFERENCES prendas(id),
  admin_id INTEGER NOT NULL REFERENCES usuarios(id),
  estado TEXT NOT NULL CHECK (estado IN ('aprobada','rechazada')),
  notas TEXT,
  creado_en TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE valoraciones (
  id SERIAL PRIMARY KEY,
  solicitud_id INTEGER NOT NULL REFERENCES solicitudes(id),
  evaluador_id INTEGER NOT NULL REFERENCES usuarios(id),
  evaluado_id INTEGER NOT NULL REFERENCES usuarios(id),
  puntaje INTEGER NOT NULL CHECK (puntaje BETWEEN 1 AND 5),
  comentario TEXT
);
CREATE TABLE movimientos (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  solicitud_id INTEGER REFERENCES solicitudes(id),
  prenda_id INTEGER REFERENCES prendas(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('bono','descuento','abono','reembolso')),
  monto INTEGER NOT NULL,
  creado_en TIMESTAMP NOT NULL DEFAULT now()
);
-- Chat de cada reserva: comprador y dueno coordinan la entrega (donde, cuando, como).
CREATE TABLE mensajes (
  id SERIAL PRIMARY KEY,
  solicitud_id INTEGER NOT NULL REFERENCES solicitudes(id) ON DELETE CASCADE,
  emisor_id INTEGER NOT NULL REFERENCES usuarios(id),
  texto TEXT NOT NULL,
  creado_en TIMESTAMP NOT NULL DEFAULT now()
);

-- =====================  DATOS DE EJEMPLO  =====================
INSERT INTO niveles (codigo,nombre,rango,intercambios_min,reputacion_min) VALUES
 ('BRONCE','Bronce',1,0,0), ('PLATA','Plata',2,3,3.5), ('ORO','Oro',3,10,4.5);

INSERT INTO estilos (codigo,nombre,tipo) VALUES
 ('VINTAGE','Vintage','epoca'), ('Y2K','Y2K','epoca'), ('90S','90s','epoca'),
 ('STREET','Streetwear','estilo');

INSERT INTO temporadas (codigo,nombre) VALUES
 ('VERANO','Verano'), ('INVIERNO','Invierno'), ('ENTRETIEMPO','Entretiempo');

INSERT INTO rarezas (codigo,nombre,saldo_minimo) VALUES
 ('COMUN','Común',0), ('RARO','Raro',40), ('EPICO','Épico',80), ('LEGENDARIO','Legendario',150);

INSERT INTO categorias (codigo,nombre,valor_base,grupo_talla) VALUES
 ('CAM','Camiseta',10,'ropa_superior'),
 ('CHA','Chaqueta',25,'ropa_superior'),
 ('VES','Vestido',30,'ropa_superior'),
 ('PAN','Pantalón',18,'ropa_inferior'),
 ('ZAP','Zapatos',20,'calzado'),
 ('CAR','Carteras',22,'accesorio'),
 ('FAL','Falda',18,'ropa_inferior'),
 ('SHO','Short',15,'ropa_inferior');

INSERT INTO estados (codigo,nombre,factor) VALUES
 ('NUEVO','Nuevo con etiqueta',1.0), ('COMO_NUEVO','Como nuevo',0.9),
 ('BUENO','Buen estado',0.75),       ('USADO','Usado',0.5);

INSERT INTO marcas (nombre,multiplicador) VALUES
 ('Genérica',0.9), ('H&M',1.0), ('Zara',1.1), ('Levis',1.2), ('Nike',1.3), ('Guess',1.3), ('Dior',1.5);

-- Contrasenas de demo: admin123 / user123  (guardadas como SHA-256)
INSERT INTO usuarios (correo,nombre,apellido,contrasena,rol) VALUES
 ('admin@rewear.com','Nicole','Yépez', encode(sha256(convert_to('admin123','UTF8')),'hex'), 'admin'),
 ('ana@rewear.com','Ana','Pérez',      encode(sha256(convert_to('user123','UTF8')),'hex'),  'user'),
 ('luis@rewear.com','Luis','Mora',     encode(sha256(convert_to('user123','UTF8')),'hex'),  'user'),
 ('sofia@rewear.com','Sofía','Castro', encode(sha256(convert_to('user123','UTF8')),'hex'),  'user'),
 ('vale@rewear.com','Valentina','Cruz', encode(sha256(convert_to('user123','UTF8')),'hex'),  'user');

-- Un solo drop para las piezas exclusivas. Nivel Bronce: TODOS pueden ENTRAR a verlo;
-- el "cupo" real de cada pieza lo pone su RAREZA (saldo minimo para desbloquearla).
INSERT INTO colecciones (nombre,nivel_min_id,temporada_id,estilo_id,inicia_en,termina_en) VALUES
 ('Piezas Exclusivas',1,1,1,'2026-11-01','2026-12-31');   -- id 1

-- =====================  CATALOGO GENERAL (coleccion_id = NULL, con foto real)  =====================
-- Valor = round(valor_base * factor_estado * multiplicador_marca) y x1.2 por verificada.
-- Dueños: Luis(3) y Sofia(4), para que Ana(2) y Valentina(5) vean y reserven todo.
INSERT INTO prendas
 (dueno_id,categoria_id,estado_id,marca_id,coleccion_id,temporada_id,rareza_id,titulo,talla,color,valor,verificada,estado,imagen) VALUES
 (3,1,1,5,NULL,1,2,'Camiseta Y2K Nike','M','Amarillo',        16,true,'disponible','/img/catalogo/item01-camiseta-y2k-nike.jpg'),  -- id 1  Raro
 (4,5,1,5,NULL,1,2,'Sneakers chunky','38','Blanco',           31,true,'disponible','/img/catalogo/item02-sneakers-chunky.jpg'),   -- id 2  Raro
 (3,1,2,2,NULL,3,1,'Top básico rosa','S','Rosa',              11,true,'disponible','/img/catalogo/item03-top-basico-rosa.jpg'),   -- id 3  Comun
 (4,2,3,1,NULL,2,3,'Chaqueta de cuero','M','Café',            20,true,'disponible','/img/catalogo/item04-chaqueta-cuero.jpg'),    -- id 4  Epico
 (3,7,3,3,NULL,1,1,'Falda denim mini','30','Azul',            18,true,'disponible','/img/catalogo/item05-falda-denim.jpg'),       -- id 5  Falda
 (4,4,3,1,NULL,2,1,'Pantalón cargo','32','Beige',             15,true,'disponible','/img/catalogo/item06-pantalon-cargo.jpg'),    -- id 6
 (3,3,2,3,NULL,3,2,'Vestido floral vintage','S','Crema',      36,true,'disponible','/img/catalogo/item07-vestido-floral.jpg'),    -- id 7  Raro
 (4,1,2,3,NULL,3,1,'Blusa de tirantes vintage','S','Beige',   12,true,'disponible','/img/catalogo/item08-blusa-tirantes.jpg'),    -- id 8
 (4,6,3,1,NULL,1,2,'Cartera vintage','Única','Café',          18,true,'disponible','/img/catalogo/item09-cartera-vintage.jpg'),   -- id 9  Raro
 (3,6,3,1,NULL,1,1,'Cartera rosa vintage','Única','Rosa',     18,true,'disponible','/img/catalogo/item10-cartera-rosa.jpg');      -- id 10

-- =====================  PIEZAS EXCLUSIVAS (drop id 1, con FOTO + FIRMA + EDICION)  =====================
-- El precio es un valor de coleccion (edicion limitada). La RAREZA pone el cupo de desbloqueo:
-- Raro=40, Epico=80, Legendario=150 creditos de saldo. Dueños Luis/Sofia (no los compradores demo).
INSERT INTO prendas
 (dueno_id,categoria_id,estado_id,marca_id,coleccion_id,temporada_id,rareza_id,titulo,talla,color,valor,verificada,estado,imagen,firma,edicion) VALUES
 (4,2,2,1,1,1,4,'Chaqueta Marty Supreme','L','Azul',    150,true,'disponible','/img/drops/excl01-chaqueta-marty.jpg','Pieza de archivo autenticada','1 de 1'),       -- id 11 Legendaria
 (3,1,2,1,1,1,3,'Blusa de pedrería vintage','S','Azul',  60,true,'disponible','/img/drops/excl02-blusa-pedreria.jpg','Bordada a mano · autenticada','1 de 1'),        -- id 12 Épica
 (4,6,3,6,1,1,2,'Cartera Guess vintage','Única','Azul',  45,true,'disponible','/img/drops/excl03-cartera-guess.jpg','Vintage original Guess · autenticada','1 de 1'),  -- id 13 Rara
 (3,6,3,7,1,1,4,'Bolso Dior vintage','Única','Beige',   150,true,'disponible','/img/drops/excl04-bolso-dior.jpg','Pieza de archivo Dior · autenticada','1 de 1');      -- id 14 Legendaria

-- =====================  EN REVISION (para la demo del administrador validando)  =====================
INSERT INTO prendas
 (dueno_id,categoria_id,estado_id,marca_id,coleccion_id,temporada_id,rareza_id,titulo,talla,color,valor,estado) VALUES
 (2,2,3,4,NULL,1,2,'Chaqueta de jean vintage','M','Azul', round(25*0.75*1.2), 'en_revision'),   -- id 15 (de Ana)
 (3,5,2,5,NULL,3,1,'Zapatillas Nike clásicas','40','Blanco', round(20*0.9*1.3), 'en_revision'); -- id 16 (de Luis)

-- Estilos de cada prenda (Vintage=1, Y2K=2, 90s=3, Streetwear=4)
INSERT INTO prenda_estilo (prenda_id,estilo_id) VALUES
 (1,2),(2,4),(3,4),(4,1),(5,3),(6,4),(7,1),(8,1),(9,1),(10,1),
 (11,4),(12,1),(13,1),(14,1),(15,1),(16,4);

-- Movimientos / saldos:
--  Bono de bienvenida a todos + abono por cada prenda disponible a su dueño.
--  Ana (compradora, 62 cr): reserva lo Comun/Raro y la exclusiva mas barata (Guess, cupo 40).
--  Valentina (coleccionista, 210 cr): llega hasta las Legendarias (cupo 150) -> demo del "si tienes el cupo".
INSERT INTO movimientos (usuario_id,prenda_id,tipo,monto) VALUES
 (2,NULL,'bono',10),(3,NULL,'bono',10),(4,NULL,'bono',10),(5,NULL,'bono',10),
 (2,NULL,'abono',52),                               -- Ana: 10 + 52 = 62
 (5,NULL,'abono',200),                              -- Valentina: 10 + 200 = 210
 (3,1,'abono',16),(3,3,'abono',11),(3,5,'abono',18),(3,7,'abono',36),(3,10,'abono',18),
 (3,12,'abono',60),(3,14,'abono',150),              -- Luis (dueño)
 (4,2,'abono',31),(4,4,'abono',20),(4,6,'abono',15),(4,8,'abono',12),(4,9,'abono',18),
 (4,11,'abono',150),(4,13,'abono',45);              -- Sofia (dueña)
