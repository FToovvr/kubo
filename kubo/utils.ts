import {
  extractReferenceFromMessage,
  mergeAdjoiningTextPiecesInPlace,
  removeReferenceFromMessage,
  tryExtractPureText,
} from "../utils/message_utils.ts";

import { now, nowMs, randBM, randInt, randIntBM } from "../utils/misc.ts";

const utils = {
  tryExtractPureText,
  mergeAdjoiningTextPiecesInPlace,
  removeReferenceFromMessage,
  extractReferenceFromMessage,

  randInt,
  randBM,
  randIntBM,
  nowMs,
  now,
};

export default utils;
