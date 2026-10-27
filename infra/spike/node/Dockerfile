FROM public.ecr.aws/docker/library/node:24-bookworm-slim
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0 /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /var/task
COPY package.json .
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs .
ENV AWS_LWA_PORT=8080 \
  AWS_LWA_READINESS_CHECK_PATH=/health \
  AWS_LWA_INVOKE_MODE=response_stream
CMD ["node", "server.mjs"]
