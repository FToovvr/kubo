export async function sleep(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

export function generateRandomInteger(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 0~1 间正态分布
// https://stackoverflow.com/a/49434653
export function generateRandomByBoxMuller(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random(); //Converting [0,1) to (0,1)
  while (v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  num = num / 10.0 + 0.5; // Translate to 0 -> 1
  if (num > 1 || num < 0) return generateRandomByBoxMuller(); // resample between 0 and 1
  return num;
}

export function generateRandomIntegerByBoxMuller(min: number, max: number) {
  return Math.floor(generateRandomByBoxMuller() * (max - min + 1)) + min;
}

export function getCurrentUTCTimestampMs() {
  return (new Date()).getTime();
}
export function getCurrentUTCTimestamp() {
  return Math.floor(getCurrentUTCTimestampMs() / 1000);
}
