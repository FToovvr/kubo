import { KuboBot } from "./../../index.ts";

export class RolesManager {
  private bot: KuboBot;

  constructor(bot: KuboBot) {
    this.bot = bot;
  }

  async canManageBotGlobally(qq: number) {
    return await this.getUserGlobalRoles(qq).canManageBotGlobally();
  }
  getRolesCanManageBotGlobally() {
    return GlobalRoles.rolesCanManageBotGlobally;
  }

  async canManageBotInScope(scope: "global" | { group: number }, qq: number) {
    if (scope === "global") {
      return await this.getUserGlobalRoles(qq).canManageBotInScope();
    } else {
      return await this.getUserGroupRoles(qq, scope.group)
        .canManageBotInScope();
    }
  }
  getRolesCanManageBotInScope(scope: "global" | "group") {
    if (scope === "global") {
      return GlobalRoles.rolesCanManageBotInScope;
    } else {
      return GroupRoles.rolesCanManageBot;
    }
  }

  getUserGlobalRoles(qq: number) {
    return new GlobalRoles(this.bot, qq);
  }

  getUserGroupRoles(qq: number, inGroup: number) {
    return new GroupRoles(this.bot, qq, inGroup);
  }
}

// TODO: 正式写一个基类
export type Roles = GlobalRoles;

export class GlobalRoles {
  protected bot: KuboBot;
  qq: number;

  constructor(bot: KuboBot, qq: number) {
    this.bot = bot;
    this.qq = qq;
  }

  async isBotSelf() {
    return this.bot.self.qq === this.qq;
  }

  async isBotOwner() {
    return this.bot.ownerQQ === this.qq;
  }

  // TODO:
  // - isBotAdmin [kubo:bot-admin]
  // - isBotTrustedUser [kubo:bot-trusted-user]

  // TODO:
  // - hasRole(roleText)

  async canManageBotGlobally() {
    return await this.isBotOwner();
  }
  static get rolesCanManageBotGlobally() {
    return [roleName_botOwner];
  }

  async canManageBotInScope() {
    return await this.canManageBotGlobally();
  }
  static get rolesCanManageBotInScope() {
    return this.rolesCanManageBotGlobally;
  }

  async getGlobalRoles(): Promise<Role[]> {
    const roles: Role[] = [];

    if (await this.isBotSelf()) {
      roles.push(role_botSelf);
    }
    if (await this.isBotOwner()) {
      roles.push(role_botOwner);
    }

    return roles;
  }

  async getRoles() {
    return await this.getGlobalRoles();
  }
}

// TODO: caching?
export class GroupRoles extends GlobalRoles {
  group: number;

  constructor(bot: KuboBot, qq: number, group: number) {
    super(bot, qq);
    this.group = group;
  }

  async isGroupOwner() {
    return await this.getRawUserRoleInGroup() === "owner";
  }

  async isGroupAdmin() {
    return await this.getRawUserRoleInGroup() === "admin";
  }

  async isGroupMember() {
    return (await this.getRawUserRoleInGroup()) !== null;
  }

  async isGroupOwnerOrAdmin() {
    const role = await this.getRawUserRoleInGroup();
    return role === "owner" || role === "admin";
  }

  async canManageBotInScope() {
    return await super.canManageBotInScope() ||
      await this.isGroupOwnerOrAdmin();
  }
  static get rolesCanManageBot() {
    return [
      ...super.rolesCanManageBotInScope,
      ...[roleName_groupOwner, roleName_groupAdmin],
    ];
  }

  async getRawUserRoleInGroup() {
    const apiClient = this.bot._client.apiClient;
    const info = await apiClient.getGroupMemberInfo(this.group, this.qq);
    if (!info) return null;

    return info.role;
  }

  // TODO:
  // - isBotInviterOfGroup kubo:group-bot-inviter[group=42]
  // - isBotManagerOfGroup kubo:group-bot-manager[group=42]

  async getGroupRoles(): Promise<Role[]> {
    const roles: Role[] = [];

    const groupRole = await this.getRawUserRoleInGroup();
    console.log({ groupRole });
    if (groupRole) {
      roles.push(makeRole_groupRole(this.group, groupRole));
    }

    return roles;
  }

  async getRoles() {
    return [
      ...(await super.getRoles()),
      ...(await this.getGroupRoles()),
    ];
  }
}

export class Role {
  namespace: "kubo" | "qq";
  internalName: string;
  displayName: string;

  scope: "global" | { group: number };

  constructor(args: {
    namespace: Role["namespace"];
    internalName: string;
    displayName: string;
    scope: Role["scope"];
  }) {
    this.namespace = args.namespace;
    this.internalName = args.internalName;
    this.displayName = args.displayName;
    this.scope = args.scope;
  }

  getDebugName(extra: { usesLongForm: boolean } = { usesLongForm: false }) {
    let scopeText: string;
    if (this.scope === "global") {
      scopeText = "";
    } else if ("group" in this.scope) {
      if (Object.keys(this.scope).length !== 1) throw new Error("never");
      if (extra.usesLongForm) {
        scopeText = `[group=${this.scope.group}]`;
      } else {
        scopeText = "";
      }
    } else {
      throw new Error("never");
    }

    return `${this.namespace}:${this.internalName}` + scopeText;
  }
}

const roleName_botSelf = "骰子自身";
const role_botSelf = new Role({
  namespace: "kubo",
  internalName: "bot-self",
  displayName: roleName_botSelf,
  scope: "global",
});

const roleName_botOwner = "骰子拥有者";
const role_botOwner = new Role({
  namespace: "kubo",
  internalName: "bot-owner",
  displayName: roleName_botOwner,
  scope: "global",
});

const roleName_groupMember = "群一般成员";
const roleName_groupOwner = "群主";
const roleName_groupAdmin = "群管理员";
function makeRole_groupRole(
  group: number,
  role: "member" | "owner" | "admin" | string,
) {
  let roleText: string;
  let displayName: string;
  if (role === "member" || role === "owner" || role === "admin") {
    roleText = role;
    if (role === "member") {
      displayName = roleName_groupMember;
    } else if (role === "owner") {
      displayName = roleName_groupOwner;
    } else {
      if (role !== "admin") throw new Error("never");
      displayName = roleName_groupAdmin;
    }
  } else {
    roleText = "unknown-" + role;
    displayName = `群未知身份（${role}）`;
  }

  return new Role({
    namespace: "qq",
    internalName: "group-" + roleText, /* + `[group=${group}]` */
    displayName,
    scope: { group },
  });
}
