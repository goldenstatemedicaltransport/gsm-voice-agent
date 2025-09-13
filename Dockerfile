# Build image for GSMT voice agent.  Designed for deployment on Google Cloud Run.
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package definition first and install dependencies.  Doing this in a
# separate layer allows Docker to cache npm install results when only
# application code changes.
COPY package*.json ./
RUN npm install --production

# Copy the rest of the application
COPY . .

# Set the port that the server listens on.  Cloud Run expects the
# container to listen on $PORT.
ENV PORT 8080

# Start the application
CMD [ "npm", "start" ]