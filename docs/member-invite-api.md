# 项目成员邀请系统 API 文档

本文档提供了基于手机号的成员邀请系统的 API 接口说明，包含完整的请求和响应参数，涵盖了状态机管理、防刷机制和日志记录功能。

---

## 1. 创建邀请 (Send Invitation)

**接口路径:** `POST /api/v1/projects/:projectId/invitations`
**功能描述:** 根据手机号列表发送项目邀请。系统会自动识别手机号是否已注册。
**权限要求:** 项目管理员 (Admin) / 项目创建者 (Owner)

### 1.1 请求参数 (Request Body)

| 参数名     | 类型   | 必填 | 描述 |
| ---------- | ------ | ---- | ---- |
| `contacts` | Array  | 是   | 被邀请联系人列表，对象格式 `[{ "value": "13800000000", "type": "phone" }]` |
| `channel`  | String | 否   | 邀请渠道，默认 `sms` |

> **注意：** 接口已不再接受 `role` 或 `remark` 参数，所有新邀请成员角色默认强制为 `visitor`。若请求体包含 `role` 或 `remark` 字段，系统将返回 400 错误码（非法字段）。

### 1.2 响应结果 (Response Body)

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "created": [
      {
        "id": "invite_1610000000_abc12",
        "contactValue": "13800000000",
        "status": "pending",
        "recipientStatus": "unregistered",
        "inviteChannel": "sms",
        "inviteLogs": [
          {
            "action": "send",
            "timestamp": 1610000000000,
            "toStatus": "pending"
          }
        ]
      }
    ],
    "duplicates": [],
    "invalid": [],
    "notifiedRegistered": [],
    "rateLimited": []
  }
}
```

* `rateLimited`: 触发防刷机制的手机号列表（24小时内最多发送3次邀请）。

### 1.3 异常响应

若请求中包含非法的 `role` 或 `remark`：

```json
{
  "code": 400,
  "message": "非法字段"
}
```

---

## 2. 重新发送邀请 (Resend Invitation)

**接口路径:** `POST /api/v1/projects/:projectId/invitations/:invitationId/resend`
**功能描述:** 对状态为 `pending` 且未过期的邀请重新发送通知，并刷新有效期。受防刷机制限制。
**权限要求:** 项目管理员 / 项目创建者

### 2.1 请求参数
无请求体。

### 2.2 响应结果

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "invitation": {
      "id": "invite_1610000000_abc12",
      "status": "pending",
      "sentCount": 2,
      "lastSentAt": "2026-04-13 10:00:00"
    }
  }
}
```
* 错误码 `429 Too Many Requests`: 该手机号24小时内发送邀请次数已达上限。

---

## 3. 撤销邀请 (Revoke Invitation)

**接口路径:** `POST /api/v1/projects/:projectId/invitations/:invitationId/revoke`
**功能描述:** 撤销一条已发送的邀请，使其状态变更为 `revoked`，对应的邀请码立即失效。
**权限要求:** 项目管理员 / 项目创建者

### 3.1 请求参数
无请求体。

### 3.2 响应结果

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "invitation": {
      "id": "invite_1610000000_abc12",
      "status": "revoked",
      "revokedAt": "2026-04-13 10:05:00"
    }
  }
}
```

---

## 4. 响应邀请 (Respond to Invitation)

**接口路径:** `POST /api/v1/invitations/:invitationId/respond`
**功能描述:** 被邀请人（需登录态）接受或拒绝项目邀请。接受后直接成为项目成员。
**权限要求:** 当前登录用户必须是被邀请人 (`invitedUserId === currentUser.id`)

### 4.1 请求参数 (Request Body)

| 参数名   | 类型    | 必填 | 描述 |
| -------- | ------- | ---- | ---- |
| `accept` | Boolean | 是   | `true` 为接受邀请，`false` 为拒绝邀请 |

### 4.2 响应结果

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "status": "accepted", 
    "projectId": "p1",
    "projectRole": "viewer"
  }
}
```

---

## 5. 状态机流转说明

- **pending (待接受)**: 邀请已发送，等待用户处理。
- **accepted (已接受)**: 用户点击了同意，已加入项目。
- **rejected (已拒绝)**: 用户点击了拒绝。
- **expired (已过期)**: 邀请发出后超过7天未处理，自动流转为此状态。
- **revoked (已撤销)**: 管理员主动撤回邀请。
