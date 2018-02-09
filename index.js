#!/home/Hiroki/.nvm/versions/node/v6.11.2/bin/node

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

const rate60 = [];
const aveRate15 = [];
const orderThreshold = 1.01;
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
                    if (err || res.statusCode !== 200) {
                        console.log(err, res.statusCode);
                        reject(err || res.statusCode);
                    }
                    else {
                        try {
                            resolve(JSON.parse(body));
                        } catch(e) {
                            reject(e);
                        }
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
                    const result = JSON.parse(body);
                    if (err || res.statusCode === 404 || result.success === false) {
                        console.log(err);
                        reject(err);
                    }
                    else {
                        resolve(result);
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
    ops['uri'] = 'https://hooks.slack.com/services/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'
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
    const len = rate60.length;
    // 1時間分の値を30s刻みで保持
    if (len >= 120) {
        rate60.shift();
    }
    rate60.push(current);

    // 15分平均値を1時間分30s刻みで保持
    if (aveRate15.length >= 120) {
        aveRate15.shift();
    }
    if (len > 30) {
        let sum = 0;
        for (let i = len - 1 ; i > len - 31; i--){
            sum += rate60[i];
        }
        aveRate15.push(sum / 30);
    }
}

function checkTrend(){
    const len = aveRate15.length;
    if (len === 0) {
        return 0;
    }

    let xSum = 0;
    let ySum = 0;
    let sxx;
    let sxy;

    for (let i = 0; i < len; i++){
        xSum += i + 1;
        ySum += aveRate15[i];
    }
    const xAve = xSum / len;
    const yAve = ySum / len;

    for (let i = 0; i < len; i++){
        const xx = i + 1 - xAve;
        sxy = xx * (aveRate15[i] - yAve);
        sxx = Math.pow(xx, 2);
    }

    if (sxx === 0) {
        return 0;
    }

    return sxy / sxx;
}

function checkRate(current, orderType) {
    // 起動して30分は待つ
    if (rate60.length <= 60){
        return false;
    }
    const rate30 = rate60.slice(60);
    const trend = checkTrend();
    console.log('trend: ', trend);
    const val = aveRate15[aveRate15.length-1];
    //const rate15 = rate30.slice(30);
    //const ave15 = rate15.reduce((a,b) => a + b, 0) / rate15.length;
    const ave30 = rate30.reduce((a,b) => a + b, 0) / rate30.length;
    const ave60 = rate60.reduce((a,b) => a + b, 0) / rate60.length;
    console.log('15val', val);
    //console.log(`30min: ${ave30}, 60min: ${ave60}, 15ave: ${val}`);
    // to buy
    if (orderType === 'buy') {
        // 15分平均で上がりそうなら買う
        if (trend > 0 && current > val){
            return true;
        }
    }
    // to sell
    else if (orderType === 'sell') {
        const buy = myOrder.buy * orderThreshold;
        // 買値より一定値超えているので売る 
        if (current > buy * orderThreshold) {
            return true;
        }
        // まだ上がりそうなら待つ
        if (trend > 10 && current > val) {
            return false;
        }
        // 15分平均で下がってるので売る
        if (current < val && trend <= 10) {
            return true;
        }
        // loss cut
        if (current < myOrder.buy * losscut) {
            return true;
        }
    }
    return false
}

function order(currentRate) {
    postBody.rate = currentRate;
    postBody.order_type = myOrder.order_type;
    if (myOrder.order_type === 'buy') {
        postBody.amount = ((myOrder.jpy / 2) / currentRate) * 0.9999;
    }
    else if (myOrder.order_type === 'sell') {
        postBody.amount = myOrder.btc;
    }
    if (postBody.amount <= 0.005) {
        return;
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
        console.log(`current: ${curentRate}`);
        storeRate(curentRate);
        // check order is existing or not
        callAPI(apiOrderOpens, 'GET', true, null).then((body) => {
            if(body.orders.length !== 0 || (myOrder.jpy <= 100 && myOrder.btc <= 0.0001)) {
                init();
                sendNotification();
                return;
            }
            const orderFlag = checkRate(curentRate, myOrder.order_type);
            //const orderFlag = true;
            if (orderFlag) {
                order(curentRate);
            }
        });
      })
      .catch(err => console.log('err', err));
}

///// main
init();
setInterval(loop, 30000);
//loop();
