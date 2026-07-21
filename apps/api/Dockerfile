FROM node:20-alpine AS base
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci

COPY packages/shared packages/shared
COPY apps/api apps/api
COPY db db

RUN npm run build --workspace=@avd-manager/shared
RUN npm run build --workspace=@avd-manager/api
RUN chmod +x apps/api/docker-entrypoint.sh

WORKDIR /repo/apps/api
EXPOSE 4000
ENTRYPOINT ["/repo/apps/api/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
