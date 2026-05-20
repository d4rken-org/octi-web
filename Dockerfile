# Two-stage build: Node 24 alpine produces the static bundle, nginx alpine
# serves it. The strict Content-Security-Policy already lives in the SPA's
# index.html meta tag — nginx ships with the default config (no auth, no
# rewrite rules, no extra MIME types needed for static PWA assets).

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
