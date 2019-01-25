import * as Joi from 'joi';
import { Traders } from './Traders';

const traderPayload: any = {
  name: Joi.string().required(),
  test: Joi.boolean(),
  strategie: Joi.string().required(),
  capital: Joi.number().required(),
  percentInvest: Joi.number().required(),
  base: Joi.string().required(),
  quote: Joi.string().required(),
  env: {
    watchList: Joi.any().required(),
    warmup: Joi.number().optional(),
    batchSize: Joi.number().optional(),
    bufferSize: Joi.number().optional(),
    backtest: {
      start: Joi.string().required(),
      stop: Joi.string().required(),
    },
    aggTimes: Joi.array().optional(),
    candleSetPlugins: Joi.array().optional(),
  },
  exchange: {
    name: Joi.string().required(),
    apiKey: Joi.string().optional(),
    apiSecret: Joi.string().optional(),
  },
};

export const routes: any[] = [
  {
    method: 'POST',
    path: '/traders',
    handler: Traders.createTrader,
    options: {
      validate: {
        payload: traderPayload,
      },
      tags: ['Traders', 'API'],
      description: 'POST Create a new trader with the given configuration',
    },
  },
  {
    method: 'GET',
    path: '/traders',
    handler: Traders.getTraders,
    options: {
      tags: ['Traders', 'API'],
      description: 'GET Fetch every traders',
    },
  },
  {
    method: 'DELETE',
    path: '/traders/{name}',
    handler: Traders.deleteTrader,
    options: {
      tags: ['Traders', 'API'],
      description: 'GET Delete a specific trader',
    },
  },
];
