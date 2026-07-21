FROM node:20-alpine AS base
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY packages/shared packages/shared
COPY apps/web apps/web

RUN npm run build --workspace=@avd-manager/shared

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN npm run build --workspace=@avd-manager/web

WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["npm", "run", "start"]
