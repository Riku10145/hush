import { measureAccuracy } from "../src/dsp/accuracy.ts";

const value = Number(process.argv[2] ?? 0.6);
console.log(JSON.stringify(measureAccuracy(value), null, 2));
