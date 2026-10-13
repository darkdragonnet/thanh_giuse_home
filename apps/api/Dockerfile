FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig*.json ./
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
COPY scripts/ ./scripts/

RUN npm ci
RUN npm run build:packages && npm run build --workspace=@thanh-giuse/api
RUN npm prune --production

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/scripts ./scripts

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "apps/api/dist/server.js"]
