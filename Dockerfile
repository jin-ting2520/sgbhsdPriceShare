# syntax=docker/dockerfile:1

########## SGBHSD 物价共享平台 镜像 ##########
# 基于 Node 24（内置 node:sqlite，零原生编译依赖），单容器即可运行
FROM node:24-alpine

# 生产环境
ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Shanghai

WORKDIR /app

# 仅先复制依赖描述文件，利用镜像缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 应用代码（.dockerignore 已排除 node_modules / data 等）
COPY . .

# SQLite 数据目录：以非 root 用户运行，保证卷挂载后可写
RUN mkdir -p /app/data /app/backup && chown -R node:node /app/data /app/backup

USER node

EXPOSE 3000

# 健康检查（Node 内置 fetch，无需额外安装 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
