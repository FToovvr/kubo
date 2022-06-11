type ResponseStatus = "ok" | string;

//==== info ====//

export interface GetGroupMemberInfoResponse {
  data: null | { // 挑一些可能有用的
    user_id: number; // QQ
    nickname: string; // QQ 昵称
    card: string; // 群名片
    card_changeable: boolean;

    join_time: number;
    last_sent_time: number;
    shut_up_timestamp: string; // 禁言截止

    role: "owner" | "admin" | "member" | string;

    level: string; // 成员等级
    title: string; // 专属头衔
    title_expire_time: number; // 专属头衔过期时间戳

    unfriendly: boolean; // 是否不良记录成员（不知道是啥）
  };

  retcode: number;
  status: ResponseStatus;
}

export interface GetGroupMemberListResponse {
  data: null | Partial<Exclude<GetGroupMemberInfoResponse["data"], null>>[];

  retcode: number;
  status: ResponseStatus;
}

export interface GetImageInfoResponse {
  data: null | {
    size: number;
    filename: string;
    url: string;
  };

  retcode: number;
  status: ResponseStatus;
}

//==== message ====//

export interface SendMessageResponse {
  // 尚不清楚失败会是什么情况
  data: null | {
    message_id: number;
  };
  retcode: number;
  status: ResponseStatus;
}

//==== request ====//

//==== mise ====

export interface DownloadFileResponse {
  data: null | {
    file: string; //相对路径
  };

  retcode: number;
  status: ResponseStatus;
}
