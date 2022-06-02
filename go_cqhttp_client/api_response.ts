export interface SendMessageResponse {
  // 尚不清楚失败会是什么情况
  data?: {
    message_id: number;
  };
  retcode: number;
  status: "ok" | string;
}
