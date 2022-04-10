import { KuboPlugin } from "../../bot.ts";
import { SensitiveFilter } from "./sensitive_filter.ts";

export default function (dict: string[]): KuboPlugin {
  const filter = new SensitiveFilter(dict);

  return {
    id: "filter_sensitive_text",

    hooks: {
      beforeSendMessage: (bot, message) => {
        return filter.filter(message);
      },
    },
  };
}
