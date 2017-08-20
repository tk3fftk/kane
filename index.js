'use strict';

const crypto = require('crypto');
const request = require('request');
const Promise = require('promise');
const fs = require('fs');

const key = '';
const secret = '';
const apiBase = 'https://coincheck.jp';
const apiBalance = 'api/accounts/balance';
const apiRate = 'api/rate/btc_jpy';
const apiOrder = 'api/exchange/orders';
const apiOrderRate = 'api/exchange/orders/rate?pair=btc_jpy&amount=1&order_type=';
const apiOrderOpens = 'api/exchange/orders/opens';

const postBody = {
    'pair': 'btc_jpy',
    'order_type': 'sell',
    'rate': 0,
    'amount': 0
};

const rate30 = [];
const orderThreshold = 1.005;
const losscut = 0.95;

let myOrder = {};

function createSig(path, body) {
    const nonce = new Date().getTime();
    const url = `${apiBase}/${path}`;
    let message = nonce + url;
    if (!!body) {
        message = message + JSON.stringify(body);
    }
    const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return {
        'ACCESS-KEY': key,
        'ACCESS-NONCE': nonce,
        'ACCESS-SIGNATURE': signature
    };
}

function noAuth() {
    return {
        'ACCESS-KEY': key,
        'ACCESS-SECRET': secret
    };
}

function callAPI(path, method, requireSig, body) {
    const options = {
        headers: requireSig ? createSig(path, body) : noAuth(),
        uri: `${apiBase}/${path}`,
    }
    switch(method) {
        case 'GET':
            return new Promise((resolve, reject) => {
                request.get(options, (err, res, body) => {
                    if (err || res.statusCode === 404) {
                        console.log(err, res.statusCode);
                        reject(err || res.statusCode);
                    }
                    else {
                        resolve(JSON.parse(body));
                    }
                });
            });
            break;
        case 'POST':
            options.body = JSON.stringify(body);
            options.headers['content-type'] = 'application/json';
            console.log(options.body);
            return new Promise((resolve, reject) => {
                request.post(options, (err, res, body) => {
                    if (err || res.statusCode === 404) {
                        console.log(err);
                        reject(err);
                    }
                    else {
                        resolve(JSON.parse(body));
                    }
                });
            });
            break;
        default:
            reject('no method');
            break;
    }
}

function sendNotification() {
    const ops = {
        headers: {},
        body: {}
    };
    ops['headers']['content-type'] = 'application/json';
    ops['body'] = JSON.stringify({text: JSON.stringify(myOrder)});
    ops['uri'] = ''
    request.post(ops, (err, res, body) => {
        if (err || res.statusCode === 404) {
            console.log(err);
        }
        else {
            console.log(body);
        }
    });
}

function storeRate(current) {
    if (rate30.length >= 30) {
        rate30.pop();
    }
    rate30.push(current);
}

function checkRate(current, orderType) {
    // to buy
    if (orderType === 'buy') {
        const ave = rate30.reduce((a,b) => a + b, 0) / rate30.length;
        if (current * orderThreshold < myOrder.sell && ave * orderThreshold < myOrder.sell) {
            return true;
        }
    }
    // to sell
    else if (orderType === 'sell') {
        if (current > myOrder.buy * orderThreshold || current < myOrder.buy * losscut) {
            return true;
        }
    }
    return false
}

function order(currentRate) {
    postBody.rate = currentRate;
    postBody.order_type = myOrder.order_type;
    if (myOrder.order_type === 'buy') {
        postBody.amount = (myOrder.jpy / currentRate) * 0.9999;
    }
    else if (myOrder.order_type === 'sell') {
        postBody.amount = myOrder.btc;
    }
    callAPI(apiOrder, 'POST', true, postBody)
      .then((result) => {
        console.log(result);
        // update order.json based on post response
        if (postBody.order_type === 'sell') {
            myOrder.sell = parseFloat(result.rate);
            myOrder.order_type = 'buy';
        } 
        else {
            myOrder.buy = parseFloat(result.rate);
            myOrder.order_type = 'sell';
        }
        callAPI(apiBalance, 'GET', true, null)
          .then((balance) => {
            myOrder.jpy = parseFloat(balance.jpy);
            myOrder.btc = parseFloat(balance.btc);
            console.log(`jpy:${myOrder.jpy}`, `btc:${myOrder.btc}`);
            outputOrder();
            sendNotification();
          })
          .catch(err => console.log(err));
      })
      .catch(err => console.log(err));
}

function outputOrder() {
    fs.writeFileSync('./order.json', JSON.stringify(myOrder), {'encoding': 'utf-8'});
}

function init() {
    myOrder = JSON.parse(fs.readFileSync('./order.json', {'encoding': 'utf-8'}));
    // 残高
    callAPI(apiBalance, 'GET', true, null)
      .then((result) => {
        myOrder.jpy = parseFloat(result.jpy);
        myOrder.btc = parseFloat(result.btc);
        console.log(`jpy:${myOrder.jpy}`, `btc:${myOrder.btc}`);
        outputOrder();
      })
      .catch(err => console.log(err));
}

function loop() {
    // get curent rate of order_type
    // order_type means type of next order (buy or sell)
    callAPI(`${apiOrderRate}${myOrder.order_type}`, 'GET', false, null)
      .then((body) => {
        const curentRate = parseFloat(body.rate);
        console.log(curentRate);
        storeRate(curentRate);
        // check order is existing or not
        callAPI(apiOrderOpens, 'GET', true, null).then((body) => {
            if(body.orders.length !== 0) {
                return;
            }
            const orderFlag = checkRate(curentRate, myOrder.order_type);
            if (orderFlag) {
                order(curentRate);
            }
        });
      })
      .catch(err => console.log('err', err));
}

///// main
init();
//setInterval(loop, 5000);
setInterval(loop, 30000);
//loop();
