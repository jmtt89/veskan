/**
 * Interruptores de funcionalidad.
 *
 * Existen para que el codigo de una funcion incompleta pueda vivir en `main`
 * sin estar activo, en lugar de mantenerlo en una rama aparte que se va
 * pudriendo.
 */

export const FEATURES = {
  /**
   * Publicar productos en Open Food Facts.
   *
   * DESACTIVADO en la v1 a proposito, no por falta de codigo.
   *
   * Para publicar hay que identificarse con la cuenta del propio usuario via
   * OAuth (OIDC con PKCE contra `auth.openfoodfacts.org`, realm
   * `openfoodfacts`). Verificado el 2026-09-16:
   *   - El proveedor esta en produccion y soporta `authorization_code` + PKCE
   *     S256, es decir, sirve para una app de navegador sin secretos.
   *   - La API de escritura YA acepta el token: `API.pm::process_auth_header`
   *     lee la cabecera Bearer, la valida contra el JWKS de Keycloak y
   *     resuelve `oidc_user_id`.
   *
   * Lo que falta no es tecnico: OFF no tiene alta automatica de clientes OIDC
   * ("No clients are pre-configured in the production and staging instances"),
   * asi que hay que solicitarlo a su equipo. Hasta que ese alta exista, la app
   * es de SOLO LECTURA y quien quiera aportar datos lo hace en la web de OFF,
   * a la que enlazamos desde cada ficha.
   *
   * Al activarlo: la seccion de participacion deja de estar en modo
   * "proximamente" y aparece el boton de conectar con Open Food Facts.
   */
  contributions: false,
} as const;

/** Estado del tramite, para poder contarlo con honestidad en la interfaz. */
export const CONTRIBUTIONS_STATUS = {
  reason: 'pendiente-alta-cliente-oidc',
  /** Lo que sí puede hacer hoy quien quiera colaborar */
  fallbackUrl: 'https://world.openfoodfacts.org',
} as const;
