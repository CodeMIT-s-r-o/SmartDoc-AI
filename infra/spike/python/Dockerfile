FROM public.ecr.aws/docker/library/python:3.13-slim
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0 /lambda-adapter /opt/extensions/lambda-adapter
RUN pip install --no-cache-dir fastapi==0.141.1 uvicorn==0.54.0
WORKDIR /var/task
COPY app.py .
ENV AWS_LWA_PORT=8080 \
  AWS_LWA_READINESS_CHECK_PATH=/health \
  AWS_LWA_INVOKE_MODE=response_stream
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
