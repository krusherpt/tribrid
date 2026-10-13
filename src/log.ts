const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];
let minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

export function setLogLevel(l: string): void {
  if ((LEVELS as readonly string[]).includes(l)) minLevel = l as Level;
}

export function log(tag: string, msg: string): void {
  console.log(`${new Date().toISOString()} [${tag}] ${msg}`);
}

export function dbg(tag: string, msg: string): void {
  if (LEVELS.indexOf(minLevel) <= LEVELS.indexOf('debug')) console.log(`${new Date().toISOString()} [${tag}] (d) ${msg}`);
}

export function warn(tag: string, msg: string): void {
  if (LEVELS.indexOf(minLevel) <= LEVELS.indexOf('warn')) console.warn(`${new Date().toISOString()} [${tag}] ! ${msg}`);
}

export function err(tag: string, msg: string): void {
  console.error(`${new Date().toISOString()} [${tag}] X ${msg}`);
}
