import { IStore, StoreWrapper } from "../../storage.ts";

interface SettingRegisterNode {
  type: "collection" | "leaf";
  name: string;
  readableName: string;
  description: string | null;
  children?: { [key: string]: SettingRegisterNode };
  // 无需用到 value 的时候会不存在，如节点类型为 "collection"
  valueType?: AllowedValueType;
  converter?: (orig: AllowedValue) => AllowedValue;
  default?: AllowedValue;
}

type AllowedValue = string | boolean | number | null;
export type AllowedValueType = "string" | "boolean" | "number";
type TypeTextToType<T extends AllowedValue> =
  | (T extends "string" ? string
    : (T extends "boolean" ? number : (T extends "number" ? number : never)))
  | null;

interface SettingNode {
  v?: AllowedValue;
  c?: { [key: string]: SettingNode };
}

function getValueType(value: AllowedValue): AllowedValueType | null {
  if (value === null) {
    return null;
  }
  return typeof value as AllowedValueType;
}

export class SettingsManager {
  private store: StoreWrapper;

  private registry: SettingRegisterNode = {
    type: "collection",
    name: "root",
    readableName: "根节点",
    description: null,
  };

  /**
   * key: 0=全局 其他=群
   */
  private caches: { [key: number]: SettingNode } = {};

  constructor(store: IStore) {
    this.store = new StoreWrapper(store, "settings");
  }

  close() {
    this.store.close();
  }

  async registerCollection(
    path: string[] | string,
    args: { info: { readableName: string; description: string } },
  ) {
    await throughPath(this.registry, path, (edge, node, isLast, curPath) => {
      if (isLast) {
        return {
          type: "collection",
          name: edge,
          ...args.info,
        };
      }
      if (node?.type === "leaf") {
        throw new Error(`值节点之下不能有其他节点！位置：${curPath}`);
      }
    });
  }

  /**
   * @param converter 如果与已存的数据不符，需要转换
   */
  async register<T extends AllowedValueType>(
    keyPath: string[] | string,
    args: {
      info: { readableName: string; description: string };
      valueType: T;
      converter?: (orig: AllowedValue) => TypeTextToType<T>;
      default?: AllowedValue;
      force?: boolean; // 其实是为了测试
    },
  ) {
    await throughPath(this.registry, keyPath, (edge, node, isLast, curPath) => {
      if (isLast) {
        return {
          type: "leaf",
          name: edge,
          ...args.info,
          valueType: args.valueType,
          ...(args.converter ? { converter: args.converter } : {}),
          ...(args.default ? { default: args.default } : {}),
        };
      }
      if (node?.type === "leaf") {
        throw new Error(`值节点之下不能有其他节点！位置：${curPath}`);
      }
    }, {
      allowReplaceLastNode: args.force ?? false,
    });
  }

  async tryGetRegisteredNode(keyPath: string[] | string): Promise<{
    node?: SettingRegisterNode;
    collectionNode?: SettingRegisterNode;
  }> {
    let node: SettingRegisterNode | null = null;
    let collectionNode: SettingRegisterNode | null = null;

    await throughPath(this.registry, keyPath, (_1, curNode, isLast, _2) => {
      if (!curNode) {
        return "break"; // node = null
      }
      if (isLast) {
        if (curNode.type === "leaf") {
          node = curNode;
        } else if (curNode.type === "collection") {
          collectionNode = curNode;
        }
      }
    });

    return {
      ...(node !== null ? { node } : {}),
      ...(collectionNode !== null ? { collectionNode } : {}),
    };
  }

  private async writeBack(scope: { group?: number }) {
    const cacheN = scope.group ?? 0;
    await this.store.set(
      scope,
      "settings",
      JSON.stringify(this.caches[cacheN].c),
    );
  }

  private async getCache(scope: { group?: number }) {
    const cacheN = scope.group ?? 0;
    if (!this.caches[cacheN]) {
      this.caches[cacheN] = {};
      const value = await this.store.get(scope, "settings");
      if (value) {
        this.caches[cacheN].c = JSON.parse(value as string);
      }
    }
    return this.caches[cacheN];
  }

  /**
   * 不假设已注册，主要用于查询命令
   * @returns null 代表有注册无值，undefined 代表未注册（即使有值）
   */
  async tryGet(
    scope: { group?: number },
    keyPath: string[] | string,
    autoFallback = false,
  ): Promise<AllowedValue | undefined> {
    const { node: regInfo } = await this.tryGetRegisteredNode(keyPath);
    if (!regInfo) { // 对应路径没有注册的值配置节点
      return undefined;
    }

    // TODO: 调整代码，增强可读性
    const scopes = [
      ...(scope.group ? [scope] : []),
      ...((!scope.group || autoFallback) ? [{}] : []),
    ];

    if (!Array.isArray(keyPath)) {
      keyPath = [keyPath];
    }

    let result: AllowedValue | undefined = undefined;
    for (const scope of scopes) {
      let cur: SettingNode = await this.getCache(scope);

      for (let i = 0; i < keyPath.length; i++) {
        const edge = keyPath[i] as string;
        if (!cur.c || !(edge in cur.c)) {
          break;
        }
        if (i === keyPath.length - 1) {
          result = cur.c[edge].v ?? null;
          if (result !== null && getValueType(result) !== regInfo.valueType) {
            if (!regInfo.converter) {
              throw new Error(
                `设置项已存值的类型与预定类型不符，且未提供转换函数！位置：${keyPath}，已存值：${result}，预定类型：${regInfo.valueType}。`,
              );
            }
            result = regInfo.converter(result);
            if (result === null) {
              if (!cur.c[edge].c || Object.keys(cur.c[edge].c!).length === 0) {
                delete cur.c[edge];
              } else {
                delete cur.c[edge].v;
              }
            } else if (regInfo.valueType !== getValueType(result)) {
              throw new Error(
                `设置项已存值转后的类型与预定类型不符！位置：${keyPath}，已存值：${result}，预定类型：${regInfo.valueType}。`,
              );
            } else {
              cur.c[edge].v = result;
            }
            await this.writeBack(scope);
          }
        } else {
          cur = cur.c[edge];
        }
      }

      if (result !== undefined && result !== null) {
        break;
      }
    }

    return result ?? (regInfo.default ?? null);
  }

  /**
   * 假设配置节点已注册
   */
  async get(
    scope: { group?: number },
    keyPath: string[] | string,
    autoFallback = false,
  ): Promise<AllowedValue> {
    const result = await this.tryGet(scope, keyPath, autoFallback);
    if (result === undefined) {
      throw new Error(`设置路径并未被注册为值节点！路径：${keyPath}`);
    }
    return result;
  }

  /**
   * @returns 如果配置节点是值节点，则为 true，否则为 undefined
   */
  async trySet(
    scope: { group?: number },
    keyPath: string[] | string,
    value: AllowedValue,
  ): Promise<true | undefined> {
    let cur = await this.getCache(scope);
    let succ = undefined;
    await throughPath(this.registry, keyPath, async (edge, node, isLast, _) => {
      if (!node || (isLast && node.type === "collection")) {
        return "break"; // result = undefined
      }
      if (isLast && value === null) {
        if (cur.c && cur.c[edge]) {
          if (!cur.c[edge].c || Object.keys(cur.c[edge].c!).length === 0) {
            delete cur.c[edge];
            await this.writeBack(scope);
          }
        }
        succ = true;
        return;
      }
      cur.c = cur.c ?? {};
      cur.c[edge] = cur.c[edge] ?? {};
      if (isLast) {
        cur.c[edge].v = value;
        await this.writeBack(scope);
        succ = true;
      } else {
        cur = cur.c[edge];
      }
    });
    return succ;
  }

  /**
   * 假设配置节点已注册
   */
  async set(
    scope: "global" | { group?: number },
    keyPath: string[] | string,
    value: AllowedValue,
  ): Promise<true> {
    if (scope === "global") {
      scope = {};
    }
    const result = await this.trySet(scope, keyPath, value);
    if (result === undefined) {
      throw new Error(`设置路径并未被注册为值节点！路径：${keyPath}`);
    }
    return result;
  }
}

type ThroughPathCallbackReturnValue = void | SettingRegisterNode | "break";
async function throughPath(
  registry: SettingRegisterNode,
  path: string[] | string,
  cb: (
    edge: string,
    node: SettingRegisterNode | null,
    isLast: boolean,
    currentPath: string[],
  ) => ThroughPathCallbackReturnValue | Promise<ThroughPathCallbackReturnValue>,
  args?: {
    allowReplaceLastNode?: boolean;
  },
) {
  if (typeof path === "string") {
    path = [path];
  }
  args = {
    allowReplaceLastNode: false,
    ...args,
  };

  let node = registry;
  const currentPath: string[] = [];
  for (const [i, edge] of path.entries()) {
    const isLast = i === path.length - 1;
    currentPath.push(edge);
    node.children = node.children ?? {};
    let child = node.children[edge] ?? null;

    const ret = await cb(edge, child, isLast, currentPath);
    if (ret instanceof Object) {
      if (!isLast) {
        throw new Error(`在穿过设置路径途中提供了新节点！位置：${currentPath}}`);
      } else if (child && !args.allowReplaceLastNode) {
        throw new Error(`提供的节点原处已存在节点！位置：${currentPath}}`);
      }
      // isLast
      node.children[edge] = ret;
    } else if (ret === "break") {
      break;
    } else {
      if (!child) {
        throw new Error(`穿过设置路径中的空设置节点！位置：${currentPath}}`);
      }
      node = child;
    }
  }
}
