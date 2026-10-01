/**
 * Formato de customId: g:<módulo>:<acción>:<dueño>[:arg1[:arg2...]]
 * - dueño = ID del usuario que abrió el panel; "0" = panel público.
 * - Nunca se confía en los argumentos: el servidor vuelve a validar todo.
 */
export interface ParsedId {
  mod: string;
  act: string;
  owner: string;
  args: string[];
}

export function cid(mod: string, act: string, owner: string, ...args: (string | number)[]): string {
  const id = ['g', mod, act, owner, ...args.map(String)].join(':');
  if (id.length > 100) throw new Error(`customId demasiado largo: ${id}`);
  return id;
}

export function parseId(raw: string): ParsedId | null {
  const parts = raw.split(':');
  if (parts.length < 4 || parts[0] !== 'g') return null;
  const [, mod, act, owner, ...args] = parts;
  if (!/^[a-z]{1,8}$/.test(mod) || !/^[a-z]{1,12}$/.test(act) || !/^(0|\d{17,20})$/.test(owner)) return null;
  return { mod, act, owner, args };
}
