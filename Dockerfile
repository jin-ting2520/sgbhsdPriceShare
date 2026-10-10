# syntax=docker/dockerfile:1

########## 三国冰河时代富甲天下跑商价格分享 镜像 ##########
# 基于 Node 24（内置 node:sqlite，零原生编译依赖），单容器即可运行
FROM node:24-alpine

# 生产环境
ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Shanghai

WORKDIR /app

# su-exec：入口脚本降权使用（root 启动修卷权限 → 以 node 用户运行）
RUN apk add --no-cache su-exec

# 仅先复制依赖描述文件，利用镜像缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 应用代码（.dockerignore 已排除 node_modules / data 等）
COPY . .
RUN chmod +x docker-entrypoint.sh

# SQLite 数据目录（挂载卷场景由入口脚本再次确保权限）
RUN mkdir -p /app/data /app/backup && chown -R node:node /app/data /app/backup

# 入口以 root 启动：mkdir/chown 挂载的数据卷后，su-exec 降权为 node 用户运行
ENTRYPOINT ["./docker-entrypoint.sh"]

EXPOSE 3000

# 健康检查（Node 内置 fetch，无需额外安装 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
