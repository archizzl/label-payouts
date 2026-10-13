/** "1 sale", "3 sales"; pass the plural when it isn't just an added s ("2 people"). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
