import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../share/models");
import Utils = require("../utils");
import Interfaces = require("../interfaces");
import moment = require("moment");
import _ = require('lodash');
import * as Promises from '../promises';
import Gdax = require("gdax");
import uuid = require('node-uuid');

interface CoinbaseOrderEmitter {
    on(event: string, cb: Function): CoinbaseOrderEmitter;
    on(event: 'open', cd: () => void): CoinbaseOrderEmitter;
    on(event: 'close', cd: () => void): CoinbaseOrderEmitter;
    on(event: 'message', cd: (data: CoinbaseOrder) => void): CoinbaseOrderEmitter;

    socket: any;
    book: any;
}

interface CoinbaseOrder {
    client_oid?: string;
    price?: string;
    side?: string;
    size: string;
    product_id: string;
    stp?: string;
    time_in_force?: string;
    post_only?: boolean;
    funds?: string;
    type?: string;
    reason?: string;
    trade_id?: number;
    maker_order_id?: string;
    taker_order_id?: string;
    order_id?: string;
    time?: string;
    new_size?: string;
    old_size?: string;
    remaining_size?: string;
}

interface CoinbaseOrderAck {
    id: string;
    error?: string;
    message?: string;
}

interface CoinbaseAccountInformation {
    id: string;
    balance: string;
    hold: string;
    available: string;
    currency: string;
}

interface CoinbaseRESTTrade {
    time: string;
    trade_id: number;
    price: string;
    size: string;
    side: string;
}

interface Product {
    id: string,
    base_currency: string,
    quote_currency: string,
    base_min_size: string,
    base_max_size: string,
    quote_increment: string,
}

interface CoinbaseAuthenticatedClient {
    getProducts(cb: (err?: Error, response?: any, ack?: Product[]) => void);
    buy(order: CoinbaseOrder, cb: (err?: Error, response?: any, ack?: CoinbaseOrderAck) => void);
    sell(order: CoinbaseOrder, cb: (err?: Error, response?: any, ack?: CoinbaseOrderAck) => void);
    cancelOrder(id: string, cb: (err?: Error, response?: any) => void);
    cancelAllOrders(cb: (err?: Error, response?: string[]) => void);
    getAccounts(cb: (err?: Error, response?: any, info?: CoinbaseAccountInformation[]) => void);
}

class CoinbaseMarketDataGateway implements Interfaces.IMarketDataGateway {
    MarketData = new Utils.Evt<Models.Market>();
    MarketTrade = new Utils.Evt<Models.MarketSide>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    private onMessage = (data: CoinbaseOrder) => {
      if (data.type == 'match' || data.type == 'open') {
          this.onOrderBookChanged(data.side === "buy" ? Models.Side.Bid : Models.Side.Ask, parseFloat(data.price));
          if (data.type == 'match') {
            this.MarketTrade.trigger(new Models.GatewayMarketTrade(
              parseFloat(data.price),
              parseFloat(data.size),
              this._timeProvider.utcNow(),
              false,
              data.side === "buy" ? Models.Side.Bid : Models.Side.Ask
            ));
          }
      }
    };

    private _cachedBids: Models.MarketSide[] = [];
    private _cachedAsks: Models.MarketSide[] = [];

    private reevalBook = () => {
        this._cachedBids = [];
        this._cachedAsks = [];
        const bidsIterator = this._client.book._bids.iterator();
        let item;
        while((item = bidsIterator.prev()) !== null && this._cachedBids.length < 13) {
            let size = 0;
            item.orders.forEach(x => size += parseFloat(x.size));
            this._cachedBids.push(new Models.MarketSide(parseFloat(item.price), size));
        };
        const asksIterator = this._client.book._asks.iterator();
        while((item = asksIterator.next()) !== null && this._cachedAsks.length < 13) {
            let size = 0;
            item.orders.forEach(x => size += parseFloat(x.size));
            this._cachedAsks.push(new Models.MarketSide(parseFloat(item.price), size));
        };
    };

    private onOrderBookChanged = (side: Models.Side, price: number) => {
        if ((side === Models.Side.Bid && this._cachedBids.length > 0 && price < this._cachedBids.slice(-1).pop().price)
          || (side === Models.Side.Ask && this._cachedAsks.length > 0 && price > this._cachedAsks.slice(-1).pop().price))
        return;

        this.raiseMarketData();
    };

    private onStateChange = () => {
        this.ConnectChanged.trigger(this._client.socket ? Models.ConnectivityStatus.Connected : Models.ConnectivityStatus.Disconnected);
        this.raiseMarketData();
    };

    private raiseMarketData = () => {
        this.reevalBook();
        if (this._cachedBids.length && this._cachedAsks.length)
            this.MarketData.trigger(new Models.Market(this._cachedBids, this._cachedAsks, this._timeProvider.utcNow()));
    };

    constructor(private _client: CoinbaseOrderEmitter, private _timeProvider: Utils.ITimeProvider) {
        this._client.on("open", data => this.onStateChange());
        this._client.on("close", data => this.onStateChange());
        this._client.on("message", data => this.onMessage(data));
    }
}

class CoinbaseOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusUpdate>();

    supportsCancelAllOpenOrders = () : boolean => { return false; };
    cancelAllOpenOrders = () : Promise<number> => {
        var d = Promises.defer<number>();
        this._authClient.cancelAllOrders((err, resp) => {
            if (!err) {
                var t = this._timeProvider.utcNow();
                _.forEach(JSON.parse(Object(resp).body), cxl_id => {
                    this.OrderUpdate.trigger({
                        exchangeId: cxl_id,
                        time: t,
                        orderStatus: Models.OrderStatus.Cancelled,
                        leavesQuantity: 0
                    });
                });

                d.resolve(resp.length);
            };
        });
        return d.promise;
    };

    generateClientOrderId = (): string => {
        return uuid();
    }

    cancelOrder = (cancel: Models.OrderStatusReport) => {
        this._authClient.cancelOrder(cancel.exchangeId, (err?: Error, resp?: any, ack?: CoinbaseOrderAck) => {
            var status: Models.OrderStatusUpdate;
            var t = this._timeProvider.utcNow();

            var msg = null;
            if (err) {
                if (err.message) msg = err.message;
            }
            else if (ack != null) {
                if (ack.message) msg = ack.message;
                if (ack.error) msg = ack.error;
            }
            if (msg !== null) {
                status = {
                    orderId: cancel.orderId,
                    rejectMessage: msg,
                    orderStatus: Models.OrderStatus.Rejected,
                    cancelRejected: true,
                    time: t,
                    leavesQuantity: 0
                };
                this.OrderUpdate.trigger(status);

                if (msg === "You have exceeded your request rate of 5 r/s." || msg === "BadRequest") {
                    this._timeProvider.setTimeout(() => this.cancelOrder(cancel), moment.duration(500));
                }

            }
            else {
                status = {
                    orderId: cancel.orderId,
                    orderStatus: Models.OrderStatus.Cancelled,
                    time: t,
                    leavesQuantity: 0
                };
            }

        });
    };

    replaceOrder = (replace: Models.OrderStatusReport) => {
        this.cancelOrder(replace);
        this.sendOrder(replace);
    };

    sendOrder = (order: Models.OrderStatusReport) => {
        var cb = (err?: Error, resp?: any, ack?: CoinbaseOrderAck) => {
            if (ack == null || typeof ack.id === "undefined") {
              if (ack==null || (ack.message && ack.message!='Insufficient funds'))
                console.warn('coinbase', 'WARNING FROM GATEWAY:', order.orderId, err, ack);
            }
            var msg = null;
            if (err) {
                if (err.message) msg = err.message;
            }
            else if (ack != null) {
                if (ack.message) msg = ack.message;
                if (ack.error) msg = ack.error;
            }
            else if (ack == null) {
                msg = "No ack provided!!";
            }

            if (msg !== null) {
              this.OrderUpdate.trigger({
                  orderId: order.orderId,
                  rejectMessage: msg,
                  orderStatus: Models.OrderStatus.Rejected,
                  time: this._timeProvider.utcNow()
              });
            }
        };

        var o: CoinbaseOrder = {
            client_oid: order.orderId,
            size: order.quantity.toFixed(8),
            product_id: this._symbolProvider.symbol
        };

        if (order.type === Models.OrderType.Limit) {
            o.price = order.price.toFixed(this._fixedPrecision);

            if (order.preferPostOnly)
                o.post_only = true;

            switch (order.timeInForce) {
                case Models.TimeInForce.GTC:
                    break;
                case Models.TimeInForce.FOK:
                    o.time_in_force = "FOK";
                    break;
                case Models.TimeInForce.IOC:
                    o.time_in_force = "IOC";
                    break;
            }
        }
        else if (order.type === Models.OrderType.Market) {
            o.type = "market";
        }

        if (order.side === Models.Side.Bid)
            this._authClient.buy(o, cb);
        else if (order.side === Models.Side.Ask)
            this._authClient.sell(o, cb);

        this.OrderUpdate.trigger({
            orderId: order.orderId,
            computationalLatency: (new Date()).getTime() - order.time.getTime()
        });
    };

    public cancelsByClientOrderId = false;

    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    private onStateChange = () => {
        this.ConnectChanged.trigger(this._client.socket ? Models.ConnectivityStatus.Connected : Models.ConnectivityStatus.Disconnected);
    };

    private onMessage = (data: CoinbaseOrder) => {
      let status: Models.OrderStatusUpdate;
      if (data.type == 'open') {
        let orderId = this._orderData.exchIdsToClientIds.get(data.order_id);
        if (typeof orderId === "undefined") return;

        status = {
            orderId: orderId,
            orderStatus: Models.OrderStatus.Working,
            time: this._timeProvider.utcNow(),
            leavesQuantity: parseFloat(data.remaining_size)
        };
      } else if (data.type == 'received') {
        if (typeof data.client_oid === "undefined" || !this._orderData.allOrders.has(data.client_oid)) return;

        status = {
            exchangeId: data.order_id,
            orderId: data.client_oid,
            orderStatus: Models.OrderStatus.Working,
            time: this._timeProvider.utcNow(),
            leavesQuantity: parseFloat(data.size)
        };
      } else if (data.type == 'change') {
        let orderId = this._orderData.exchIdsToClientIds.get(data.order_id);
        if (typeof orderId === "undefined") return;

        status = {
            orderId: orderId,
            orderStatus: Models.OrderStatus.Working,
            time: this._timeProvider.utcNow(),
            quantity: parseFloat(data.new_size)
        };

      } else if (data.type == 'match') {
        let liq: Models.Liquidity = Models.Liquidity.Make;
        let client_oid = this._orderData.exchIdsToClientIds.get(data.maker_order_id);

        if (typeof client_oid === "undefined") {
            liq = Models.Liquidity.Take;
            client_oid = this._orderData.exchIdsToClientIds.get(data.taker_order_id);
        }

        if (typeof client_oid === "undefined") return;

        status = {
            orderId: client_oid,
            orderStatus: Models.OrderStatus.Working,
            time: this._timeProvider.utcNow(),
            lastQuantity: parseFloat(data.size),
            lastPrice: parseFloat(data.price),
            liquidity: liq
        };
      } else if (data.type == 'done') {
        let orderId = this._orderData.exchIdsToClientIds.get(data.order_id);
        if (typeof orderId === "undefined") return;

        status = {
            orderId: orderId,
            orderStatus: data.reason === "filled"
              ? Models.OrderStatus.Complete
              : Models.OrderStatus.Cancelled,
            time: this._timeProvider.utcNow(),
            leavesQuantity: 0
        };
      }

      this.OrderUpdate.trigger(status);
    };

    private _fixedPrecision;

    constructor(
        minTick: number,
        private _timeProvider: Utils.ITimeProvider,
        private _orderData: Interfaces.IOrderStateCache,
        private _client: CoinbaseOrderEmitter,
        private _authClient: CoinbaseAuthenticatedClient,
        private _symbolProvider: CoinbaseSymbolProvider) {
        this._fixedPrecision = -Math.floor(Math.log10(minTick));
        this._client.on("open", data => this.onStateChange());
        this._client.on("close", data => this.onStateChange());
        this._client.on("message", data => this.onMessage(data));
    }
}

class CoinbasePositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    private onTick = () => {
        this._authClient.getAccounts((err?: Error, resp?: any, data?: CoinbaseAccountInformation[]|{message: string}) => {
            try {
              if (Array.isArray(data)) {
                    _.forEach(data, d => {
                        var c = Models.toCurrency(d.currency);
                        var rpt = new Models.CurrencyPosition(parseFloat(d.available), parseFloat(d.hold), c);
                        this.PositionUpdate.trigger(rpt);
                    });
                }
                else {
                    console.warn('coinbase', 'Unable to get Coinbase positions', data)
                }
            } catch (error) {
                console.error('coinbase', error, 'Exception while downloading Coinbase positions', data)
            }
        });
    };

    constructor(
        timeProvider: Utils.ITimeProvider,
        private _authClient: CoinbaseAuthenticatedClient) {
        timeProvider.setInterval(this.onTick, moment.duration(7500));
        this.onTick();
    }
}

class CoinbaseBaseGateway implements Interfaces.IExchangeDetailsGateway {
    public get hasSelfTradePrevention() {
        return true;
    }

    exchange(): Models.Exchange {
        return Models.Exchange.Coinbase;
    }

    makeFee(): number {
        return 0;
    }

    takeFee(): number {
        return 0;
    }

    name(): string {
        return "Coinbase";
    }

    constructor(public minTickIncrement: number, public minSize: number) {}
}

class CoinbaseSymbolProvider {
    public symbol: string;

    constructor(pair: Models.CurrencyPair) {
        this.symbol = Models.fromCurrency(pair.base) + "-" + Models.fromCurrency(pair.quote);
    }
}

class Coinbase extends Interfaces.CombinedGateway {
    constructor(authClient: CoinbaseAuthenticatedClient, config: Config.IConfigProvider,
        orders: Interfaces.IOrderStateCache, timeProvider: Utils.ITimeProvider,
        symbolProvider: CoinbaseSymbolProvider, quoteIncrement: number, minSize: number) {

        const orderEventEmitter = new Gdax.OrderbookSync(symbolProvider.symbol, config.GetString("CoinbaseRestUrl"), config.GetString("CoinbaseWebsocketUrl"), authClient);

        const orderGateway = config.GetString("CoinbaseOrderDestination") == "Coinbase" ?
            <Interfaces.IOrderEntryGateway>new CoinbaseOrderEntryGateway(quoteIncrement, timeProvider, orders, orderEventEmitter, authClient, symbolProvider)
            : new NullGateway.NullOrderGateway();

        const positionGateway = new CoinbasePositionGateway(timeProvider, authClient);
        const mdGateway = new CoinbaseMarketDataGateway(orderEventEmitter, timeProvider);

        super(
            mdGateway,
            orderGateway,
            positionGateway,
            new CoinbaseBaseGateway(quoteIncrement, minSize));
    }
};

export async function createCoinbase(config: Config.IConfigProvider, orders: Interfaces.IOrderStateCache, timeProvider: Utils.ITimeProvider, pair: Models.CurrencyPair) : Promise<Interfaces.CombinedGateway> {
    const authClient : CoinbaseAuthenticatedClient = new Gdax.AuthenticatedClient(config.GetString("CoinbaseApiKey"),
            config.GetString("CoinbaseSecret"), config.GetString("CoinbasePassphrase"), config.GetString("CoinbaseRestUrl"));

    const d = Promises.defer<Product[]>();
    authClient.getProducts((err, _, p) => {
        if (err) d.reject(err);
        else d.resolve(p);
    });
    const products = await d.promise;

    const symbolProvider = new CoinbaseSymbolProvider(pair);

    for (let p of products) {
        if (p.id === symbolProvider.symbol)
            return new Coinbase(authClient, config, orders, timeProvider, symbolProvider, parseFloat(p.quote_increment), parseFloat(p.base_min_size));
    }

    throw new Error("unable to match pair to a coinbase symbol " + pair.toString());
}