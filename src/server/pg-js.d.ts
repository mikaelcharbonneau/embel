// pg's documented JS subpath and its locked pool dependency have no standalone
// declarations. The runtime imports these paths directly to exclude native pg.
declare module "pg/lib/client.js" {
  const Client: typeof import("pg").Client;
  export default Client;
}
declare module "pg-pool" {
  const Pool: new (configuration: import("pg").PoolConfig & { Client: typeof import("pg").Client }) => import("pg").Pool;
  export default Pool;
}
