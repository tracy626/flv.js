var http = require('http');
var fs = require('fs');
var express = require('express');
var path = require('path');
var app = express.createServer();
// var server = http.createServer(app);

const hostname = '127.0.0.1';
var port = 3000;

app.set('port', process.env.PORT || port);
app.set('view engine', 'html');
app.set('views', path.join(__dirname, 'demo'));
app.use(express.static('demo'));
app.use('/dist', express.static('dist'));

app.get('/',function(req, res) {
  // res.setHeader('Access-Control-Allow-Origin', '*');
  res.render('index');
});

// const server = http.createServer((req, res) => {
//     fs.readFile('./demo/index.html', (err, data) => {
//       res.writeHead(200, {'Access-Control-Allow-Origin': '*'});
//       res.write(data);
//       res.end();
//     });
// });

app.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});