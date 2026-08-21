# Node 24 ejecuta TypeScript directamente, asi que no hay paso de compilacion:
# lo que se despliega es el mismo codigo que se lee.
FROM node:24-slim AS dependencias
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencias /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# El proceso nunca corre como root.
USER node
EXPOSE 3000
CMD ["node", "src/server.ts"]
