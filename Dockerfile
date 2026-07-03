# Stage 1: build the static bundle and run the air-gap origin gate.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm run verify:airgap

# Stage 2: serve dist/ with nginx. Railway injects PORT; the template
# mechanism in the official image substitutes it at container start.
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV PORT=8080
EXPOSE 8080
