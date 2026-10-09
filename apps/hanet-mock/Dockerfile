# Stage 1: Build source code trong ngữ cảnh monorepo
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root manifests và workspace manifests để tận dụng Docker layer cache
COPY package*.json tsconfig*.json ./
COPY packages/ ./packages/
COPY apps/hanet-mock/ ./apps/hanet-mock/

# Cài đặt toàn bộ dependencies và build riêng workspace hanet-mock
RUN npm ci
RUN npm run build --workspace=@thanh-giuse/hanet-mock

# Prune devDependencies chỉ giữ lại production packages
RUN npm prune --production

# Stage 2: Runtime image tối giản
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0

# Chạy dưới quyền user non-root 'node' có sẵn trong Alpine
USER node

# Copy artifacts đã build và production dependencies
COPY --chown=node:node --from=builder /app/package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/packages ./packages
COPY --chown=node:node --from=builder /app/apps/hanet-mock ./apps/hanet-mock

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4000/health || exit 1

CMD ["node", "apps/hanet-mock/dist/index.js"]
