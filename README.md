# ReWear Market

Plataforma web de moda circular: las personas entregan ropa que ya no usan a cambio de
créditos internos, el administrador valida cada prenda y la pone en el stock, y la comunidad
reserva piezas únicas. Es la plataforma completa (lado del usuario y lado de la administración).

## Tecnologías

- React (vista, en frontend/index.html)
- Express (controlador / API REST, en backend/server.js)
- PostgreSQL (modelo / base de datos). Funciona con PostgreSQL local o con Supabase.

Patrón Modelo-Vista-Controlador (MVC).

## Estructura de carpetas

    ReWear-Final/
      backend/
        server.js          Servidor Express con todas las rutas
        db.sql             Crea las tablas y carga los datos de ejemplo
        package.json       Dependencias (express, pg, cors, dotenv)
        .env.example       Plantilla de configuración
      frontend/
        index.html         Toda la interfaz (React)
        vendor/            React y Babel guardados en local
      README.md

## Requisitos

- Node.js (versión 18 o más nueva)
- Una base de datos PostgreSQL: puede ser Supabase (en la nube, más fácil) o PostgreSQL local.

---

## Cómo ejecutarlo con Supabase (recomendado)

1. Entra a supabase.com, crea una cuenta y un proyecto nuevo.
2. Ve a: Project Settings -> Database -> Connection string -> URI, y copia esa dirección
   (empieza con `postgresql://`).
3. Abre el editor SQL de Supabase (SQL Editor), pega todo el contenido de `backend/db.sql`
   y pulsa Run. Esto crea las tablas y los datos de ejemplo.
4. En la carpeta `backend`, copia `.env.example` como `.env` y pega tu dirección en `DATABASE_URL`.
5. En una terminal, dentro de `backend`:

       npm install
       npm start

6. Abre http://localhost:3000

El código activa la conexión segura (SSL) automáticamente cuando la dirección no es local,
así que con Supabase funciona sin configurar nada más.

---

## Cómo ejecutarlo con PostgreSQL local

1. Crea la base de datos y carga el esquema:

       psql -U postgres -c "CREATE DATABASE rewear"
       psql -U postgres -d rewear -f backend/db.sql

2. En la carpeta `backend`, copia `.env.example` como `.env` y deja la dirección local
   (la opción A del archivo).
3. En una terminal, dentro de `backend`:

       npm install
       npm start

4. Abre http://localhost:3000

---

## Cuentas de demostración

- Administrador: admin@rewear.com / admin123
- Usuaria: ana@rewear.com / user123  (62 créditos)
- Usuario: luis@rewear.com / user123
- Usuaria: sofia@rewear.com / user123
- Coleccionista: vale@rewear.com / user123  (210 créditos)

Ana tiene 62 créditos: puede reservar el catálogo y la exclusiva más barata (Cartera Guess),
pero NO las Legendarias (le pide el cupo de 150). Valentina tiene 210 créditos: desbloquea
hasta las piezas Legendarias. Así se demuestra que una pieza exclusiva solo se puede solicitar
si tienes el cupo de créditos de su rareza (Raro 40, Épico 80, Legendario 150).

## Qué puede hacer cada rol

Usuario:
- Ver su panel (saldo, nivel, reputación y la escalera de rarezas).
- Explorar el catálogo con filtros (estilo, temporada, rareza, talla y solo verificadas).
- Ver el detalle de una prenda con el desglose de cómo se calcula su valor.
- Comparar prendas.
- Entregar una prenda para validación (la talla depende de la categoría).
- Reservar una prenda eligiendo método de entrega (retiro en punto o envío a domicilio): el sistema retiene los créditos para evitar el doble gasto.
- Coordinar la entrega con el dueño por un chat dentro de cada reserva.
- Seguir el estado del pedido (reservada -> enviada -> entregada) y cancelar con reembolso antes de recibir.
- Confirmar la recepción: los créditos se transfieren al dueño en una sola transacción.
- Gestionar sus ventas (reservas de sus propias prendas): marcar como enviada y chatear con el comprador.
- Valorar la experiencia y ver su billetera con los movimientos.
- Ver los drops exclusivos a los que llega según su nivel.

Administrador:
- Validar las prendas en revisión (aprobar o rechazar) e ingresarlas al stock.
- Validar las prendas que entregan los usuarios, gestionar los parámetros del Core, crear drops y consultar usuarios (solo lectura: cada usuario se registra por su cuenta).
- **Registrar (admin) vs. Entregar (usuario):**
  - *Entregar (usuario):* el usuario sube su propia ropa. Es el flujo normal.
  - *Registrar (admin):* la plataforma sube piezas propias — exclusivas y de drops (ej. Bolso Dior, Chaqueta Marty), ediciones limitadas que consigue la plataforma. No es para manejar el clóset de nadie.
  - *Recepción física (intake):* cuando alguien lleva ropa a un punto físico, el staff la registra desde aquí.

## Notas técnicas

- Los créditos se calculan y validan siempre en el servidor. La página nunca envía un monto.
  Fórmula: valor = redondear(valor_base x factor_estado x multiplicador_marca); x1.2 si es auténtica.
- Las operaciones que mueven créditos o cambian el estado de una prenda usan transacciones.
- Las claves foráneas se eligen en listas desplegables; la talla depende de la categoría.
- Las sesiones se guardan en memoria: si reinicias el servidor, hay que volver a iniciar sesión.
- Las contraseñas se guardan como huella (hash), nunca en texto.
