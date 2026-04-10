const winston = require('winston');
require('winston-seq-updated');

const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.Console(),

    new winston.transports.Seq({
      serverUrl: 'https://seq.usevixa.com',
      apiKey: 'OHHfwZvuzymWm2oh1lYJ', // <-- important
      onError: (e) => console.error('SEQ error:', e)
    })
  ]
});

module.exports = logger;