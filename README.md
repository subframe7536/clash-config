# clash-config

自用 clash 配置

## 主要规则

https://github.com/SukkaW/Surge

https://github.com/MetaCubeX/meta-rules-dat

## 搭建脚本

https://github.com/yonggekkk/sing-box-yg

## Cloudflare Worker

1. 部署脚本，生成链接
2. 复制 [worker.js](./worker.js) 到 Cloudflare Worker 界面
3. 配置以下环境变量，重新部署

| 环境变量                | 必填 | 说明                                          |
| ----------------------- | ---- | --------------------------------------------- |
| `ACCESS_TOKEN`          | 是   | 订阅链接的 token                              |
| `SUBSCRIPTION_BASE_URL` | 是   | 订阅链接的 Base URL                           |
| `SUB_URL_<num>`         | 否   | 数字（例如 `SUB_URL_1`），自定义订阅链接地址  |
| `SUB_NAME_<num>`        | 否   | 数字（例如 `SUB_NAME_1`），自定义订阅链接名称 |
