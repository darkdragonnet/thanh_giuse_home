# docker/nginx/Dockerfile

# -------------------------------------------------------------
# STAGE 1: Build Static Assets cho Frontend
# -------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /build

# Copy root configs và packages
COPY package*.json tsconfig*.json ./
COPY packages/ ./packages/
COPY apps/admin/ ./apps/admin/
COPY apps/student/ ./apps/student/

# Cài đặt dependencies và build static assets
RUN npm ci --ignore-scripts || npm install
RUN npm run build:packages
RUN npm run build --workspace=@thanh-giuse/admin
RUN mkdir -p apps/student/dist && cp apps/student/index.html apps/student/dist/index.html

# -------------------------------------------------------------
# STAGE 2: Nginx Runtime (Không có Node.js Runtime)
# -------------------------------------------------------------
FROM nginx:alpine

# Copy cấu hình Nginx
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf

# Copy artifacts tĩnh từ stage builder vào web root
COPY --from=builder /build/apps/student/dist/ /usr/share/nginx/html/student/
COPY --from=builder /build/apps/admin/dist/ /usr/share/nginx/html/admin/

# Tạo thư mục mount ảnh tĩnh
RUN mkdir -p /app/storage/images

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
