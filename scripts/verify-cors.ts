import http from 'http';

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/auth/login',
  method: 'OPTIONS',
  headers: {
    'Origin': 'http://example.com',
    'Access-Control-Request-Method': 'POST'
  }
};

console.log("Sending OPTIONS request to http://localhost:3000/api/auth/login with Origin: http://example.com");

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  console.log(`HEADERS: ${JSON.stringify(res.headers, null, 2)}`);
  
  if (res.headers['access-control-allow-origin'] === 'http://example.com' &&
      res.headers['access-control-allow-credentials'] === 'true') {
      console.log('✅ CORS verification passed!');
  } else {
      console.log('❌ CORS verification failed!');
  }
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.end();
