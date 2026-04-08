const bcrypt = require('bcrypt');
const password = 'secreto123';
bcrypt.hash(password, 10).then(hash => console.log(hash)).catch(console.error);