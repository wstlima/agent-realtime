FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN npm run build
EXPOSE 4000
ENV NODE_ENV=production
CMD ["node","dist/index.js"]
