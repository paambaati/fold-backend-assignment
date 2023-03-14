FROM --platform=linux/amd64 amazon/aws-lambda-nodejs:18
WORKDIR ${LAMBDA_TASK_ROOT}

COPY package.json package-lock.json ./
RUN npm install --production
COPY index.mjs ./
COPY script.sql ./

CMD [ "index.handler" ]
