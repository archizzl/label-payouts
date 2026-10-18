/** "1 sale", "3 sales"; pass the plural when it isn't just an added s ("2 people"). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Flag Day’s", "Dee and the Dials’". */
export const possessive = (name: string) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);

/** A few names, and how many more ("Ana, Ben, Cy and 12 more"): a big label's roster doesn't fill the page. */
export const someNames = (names: string[], max = 5) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
