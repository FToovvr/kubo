import { createCanvas } from "https://deno.land/x/canvas@v1.4.1/mod.ts";
import { KuboPlugin } from "../../../index.ts";
import { encode as encodeBase64 } from "https://deno.land/std@0.95.0/encoding/base64.ts";
import {
  imageFromBase64,
  text,
} from "../../../../go_cqhttp_client/message_piece.ts";

const id = "random_single_color_image";

export default function () {
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      bot.commands.registerCommand("随机单色图片", {
        readableName: "随机单色图片",
        description: "[DEBUG] 生成随机单色图片（测试发送图片）",
        callback: () => {
          const canvas = createCanvas(1, 1);
          const ctx = canvas.getContext("2d");
          const [r, g, b] = [
            bot.utils.randInt(0, 255),
            bot.utils.randInt(0, 255),
            bot.utils.randInt(0, 255),
          ];
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(0, 0, 1, 1);
          const base64 = encodeBase64(canvas.toBuffer());
          return [
            imageFromBase64(base64),
            text(ctx.fillStyle),
          ];
        },
      });
    },
  };

  return plugin;
}
