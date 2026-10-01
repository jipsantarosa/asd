/** Interfaz mínima de base de datos síncrona (implementada con better-sqlite3). */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Db {
  run(sql: string, ...params: unknown[]): RunResult;
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
  exec(sql: string): void;
  /**
   * Ejecuta fn dentro de una transacción. Es síncrona: ningún otro evento de Discord
   * puede ejecutarse en medio, por lo que "comprobar y luego escribir" es atómico.
   * Las llamadas anidadas se convierten en savepoints.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}
