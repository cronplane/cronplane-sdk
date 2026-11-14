export function greeting(who: string, shout: boolean): string {
  const text = `hello ${who}`;
  return shout ? text.toUpperCase() : text;
}
