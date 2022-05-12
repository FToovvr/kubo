export async function sleep(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

export function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 0~1 间正态分布
// https://stackoverflow.com/a/49434653
// BM = box muller
export function randBM(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random(); //Converting [0,1) to (0,1)
  while (v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  num = num / 10.0 + 0.5; // Translate to 0 -> 1
  if (num > 1 || num < 0) return randBM(); // resample between 0 and 1
  return num;
}

export function randIntBM(min: number, max: number) {
  return Math.floor(randBM() * (max - min + 1)) + min;
}

export function nowMs() {
  return (new Date()).getTime();
}
export function now() {
  return Math.floor(nowMs() / 1000);
}
