# Use the official Node.js 20 LTS image
FROM node:20-slim

# Create app directory inside the container
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Bundle app source (Copies everything including the 'src' folder)
COPY . .

# Expose the port
EXPOSE 3000

# Start the application 
# Since index.js is inside the src folder, we point to src/index.js
CMD [ "node", "src/index.js" ]