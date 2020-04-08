import { writeFileSync, mkdirSync } from 'fs';
import { mean } from 'mathjs';
import PQueue from 'p-queue';

import { logger, TraderWorker as TraderWorkerBase, TraderConfig } from '../../../exports';
import { deepFind } from '../../../_core/helpers';
import { Status, PortfolioTrade } from '@src/_core/exports';

interface Fitness {
  currentProfit: number;
  percentTradeWin: number;
  sharpeRatio: number;
  tradeFrequency: number;
  total: number;
  [name: string]: number;
}

class TraderWorker extends TraderWorkerBase {
  public fitnesses: Fitness[];
  public hasRunned: boolean = false;
}

interface GeneticOpts {
  silent: boolean;
  threads: number;
  generation: number;
  popSize: number;
  elitism: number;
  mutationRate: number;
  envs: Array<{ start: string; stop: string }>;
  genes: Gene[];
}

interface Gene {
  key: string;
  min: number;
  max: number;
  integer?: boolean;
  list?: string[];
}

function randomBetween(min: number, max: number, integer?: boolean): number {
  if (integer === true) return Math.floor(Math.random() * (max - min + 1) + min);
  return Math.random() * (max - min) + min;
}

function createTraderWorker(
  traderConfig: TraderConfig,
  name: string,
  stratOpts: TraderConfig['stratOpts'],
  silent: boolean = true
) {
  traderConfig.env.aggTimes = [];
  traderConfig.env.candleSetPlugins = [];
  const trader = new TraderWorker(
    {
      ...traderConfig,
      stratOpts,
      name,
    },
    { silent }
  );
  trader.hasRunned = false;
  return trader;
}

function randomIndiv(traderConfig: TraderConfig, opts: GeneticOpts, gen: number, ind: number): TraderWorker {
  const newOpts = { ...traderConfig.stratOpts };
  opts.genes.forEach(g => {
    if (g.list) {
      newOpts[g.key] = g.list[randomBetween(0, g.list.length - 1, true)];
    } else {
      newOpts[g.key] = randomBetween(g.min, g.max, g.integer);
    }
  });
  return createTraderWorker(traderConfig, `${traderConfig.name}-gen${gen}-ind${ind}`, newOpts, opts.silent);
}

function tournamentSelection(generation: TraderWorker[], participant: number = 4): TraderWorker[] {
  const checkSameFitness = (indivs: TraderWorker[], fitness: number) => {
    for (const trader of indivs) {
      if (getFitness(trader) === fitness) return true;
    }
    return false;
  };
  const traders: TraderWorker[] = [];
  // Select X random participant
  for (let i = 0; i < participant; i++) {
    let trader = generation[randomBetween(0, generation.length - 1, true)];
    let j = 0;
    while (j++ < generation.length && checkSameFitness(traders, getFitness(trader))) {
      trader = generation[randomBetween(0, generation.length - 1, true)];
    }
    traders.push(trader);
  }
  // return 2 best traders from tournament
  return traders.sort((a: any, b: any) => getFitness(b) - getFitness(a)).slice(0, 2);
  // multi objective selection
  /* TODO: Test multi objective
  traders.forEach((t1: any, idx1: number) => {
    t1.rank = 0;
    traders.forEach((t2, idx2) => {
      if (idx1 !== idx2) {
        const t1Fit = [
          getFitness(t1, 'currentProfit'),
          getFitness(t1, 'percentTradeWin'),
          getFitness(t1, 'sharpeRatio'),
        ];
        const t2Fit = [
          getFitness(t2, 'currentProfit'),
          getFitness(t2, 'percentTradeWin'),
          getFitness(t2, 'sharpeRatio'),
        ];
        let t1Dominance = 0;
        let t2Dominance = 0;
        for (let i = 0; i < t1Fit.length; i++) {
          if (t1Fit[i] > t2Fit[i]) t1Dominance++;
          if (t1Fit[i] < t2Fit[i]) t2Dominance++;
        }
        if (t1Dominance > t2Dominance) t1.rank++;
      }
    });
  });
  return traders.sort((a: any, b: any) => b.rank - a.rank).slice(0, 2);*/
}

function getFitness(trader: TraderWorker, key: string = 'total'): number {
  let sum = 0;
  for (const fitness of trader.fitnesses) {
    sum += fitness[key];
  }
  const score = sum / trader.fitnesses.length;
  // Add 0.5 bonus points to total
  // let bonus = 0;
  /*if (key === 'total') {
    if (trader.fitnesses.filter(f => f.currentProfit > 0.05).length === trader.fitnesses.length) bonus += 0.25;
    if (trader.fitnesses.filter(f => f.percentTradeWin > 0.6).length === trader.fitnesses.length) bonus += 0.25;
  }*/
  return score; // + bonus;
}

function calcSharpeRatio(tradeHistory: PortfolioTrade[]) {
  const sumT = tradeHistory.reduce((sum, t) => (sum += t.orderProfit), 0);
  const meanT = sumT / tradeHistory.length;
  const squaredMeanDiff = tradeHistory.reduce(
    (sum, t) => (sum += (t.orderProfit - meanT) * (t.orderProfit - meanT)),
    0
  );
  const stdDev = Math.sqrt(squaredMeanDiff / tradeHistory.length);
  const sharpeRatio = (meanT - 0.005) / stdDev;
  return sharpeRatio;
}

function calcFitness(trader: TraderWorker): Fitness {
  // Current Profit
  let currentProfit = deepFind(trader, 'trader.portfolio.indicators.currentProfit');
  currentProfit = currentProfit === undefined || currentProfit === 0 ? -1 : currentProfit;
  // Percent Trade Win
  const tradeHistory: PortfolioTrade[] = deepFind(trader, 'trader.portfolio.tradeHistory') || [];
  const percentTradeWin =
    tradeHistory.length > 0 ? tradeHistory.filter(trade => trade.orderProfit > 0.002).length / tradeHistory.length : 0;
  // Sharpe ratio
  let sharpeRatio = tradeHistory.length > 1 ? calcSharpeRatio(tradeHistory) : 0;
  sharpeRatio = sharpeRatio < 0 ? 0 : sharpeRatio > 4 ? 4 : sharpeRatio;
  // Trade Frequency (score=1 if more than 1 trade every 2 weeks)
  const { start, stop } = trader.config.env.backtest!;
  const limit = Math.floor(daysBetween(new Date(start), new Date(stop)) / 14);
  const tradeFrequency = tradeHistory.length > limit ? 1 : tradeHistory.length / limit;
  return {
    currentProfit,
    percentTradeWin,
    sharpeRatio,
    tradeFrequency,
    total: currentProfit + 0.5 * percentTradeWin + 0.5 * tradeFrequency + sharpeRatio / 4,
  };
}

function mutate(
  traderConfig: TraderConfig,
  trader: TraderWorker,
  opts: GeneticOpts,
  gen: number,
  ind: number
): TraderWorker {
  const oldOpts = trader.config.stratOpts;
  const newOpts = { ...oldOpts };
  opts.genes.forEach(g => {
    // If gene should mutate
    if (randomBetween(0, 1) <= opts.mutationRate) {
      // Mutate value from list
      if (g.list) {
        newOpts[g.key] = g.list[randomBetween(0, g.list.length - 1, true)];
      }
      // Mutate numeric value
      // Mutation move value between 0.5% to 50%
      else {
        const direction = randomBetween(0, 1, true) === 0 ? -1 : 1;
        const range = g.max - g.min;
        const diff = range * randomBetween(0.005, 0.5) * direction;
        let newVal = oldOpts[g.key] + diff;
        newVal = newVal < g.min ? g.min : newVal > g.max ? g.max : newVal;
        newOpts[g.key] = g.integer ? Math.floor(newVal) : newVal;
      }
    }
  });
  return createTraderWorker(traderConfig, `${traderConfig.name}-gen${gen}-ind${ind}`, newOpts, opts.silent);
}

function crossover(name: string, traderA: TraderWorker, traderB: TraderWorker, opts: GeneticOpts): TraderWorker {
  // Set gene as traderB
  const newOpts = { ...traderB.config.stratOpts };
  // Take some gene of traderA if mutation prob OK
  opts.genes.forEach(g => {
    if (randomBetween(0, 1) < 0.5) {
      if (g.list) newOpts[g.key] = g.list[randomBetween(0, g.list.length - 1, true)];
      else newOpts[g.key] = traderA.config.stratOpts[g.key];
    }
  });
  // mutate new indiv (25% chance)
  if (randomBetween(0, 1) < 0.25) {
    opts.genes.forEach(g => {
      if (randomBetween(0, 1) <= opts.mutationRate) {
        if (g.list) newOpts[g.key] = g.list[randomBetween(0, g.list.length - 1, true)];
        else newOpts[g.key] = randomBetween(g.min, g.max, g.integer);
      }
    });
  }
  return createTraderWorker(traderA.trader.config, name, newOpts, opts.silent);
}

function breedNewGeneration(
  traderConfig: TraderConfig,
  generation: TraderWorker[],
  opts: GeneticOpts,
  gen: number
): TraderWorker[] {
  // sort by fitness (but keep only different fitness at the top => try to avoid same indiv convergence)
  generation = generation.sort((a: any, b: any) => getFitness(b) - getFitness(a));
  const generationResort: TraderWorker[] = [];
  let currentIdx = 1;
  // Sort indiv by fitness (take care of keeping only one version of each individu)
  generation.forEach((indiv, idx) => {
    // keep best indiv (first one)
    if (idx === 0) generationResort.push(indiv);
    else {
      // If same fitness push back
      if (getFitness(indiv) - getFitness(generation[idx - 1]) === 0) generationResort.push(indiv);
      // Else push front
      else generationResort.splice(currentIdx++, 0, indiv);
    }
  });
  generation = generationResort;

  /* CREATE NEW GENERATION */
  const newGeneration: TraderWorker[] = [];
  // keep best indiv
  const bestIndivs = generation.slice(0, opts.elitism);
  newGeneration.push(...bestIndivs);
  // Mutate or breed new indiv
  while (newGeneration.length < opts.popSize) {
    const rand = randomBetween(0, 1);
    // Breed indiv using crossover (60%)
    if (rand < 0.6) {
      // Get parent1 and 2 randomly (Make sure parent1 and 2 are different)
      const [t1, t2] = tournamentSelection(generation, 4);
      // create children
      newGeneration.push(crossover(`${traderConfig.name}-gen${gen}-ind${newGeneration.length}`, t1, t2, opts));
    }
    // Breed indiv using mutation (30%)
    else if (rand < 0.9) {
      const t = generation[randomBetween(0, generation.length - 1, true)];
      newGeneration.push(mutate(traderConfig, t, opts, gen, newGeneration.length));
    }
    // New random indiv (10%)
    else {
      newGeneration.push(randomIndiv(traderConfig, opts, gen, newGeneration.length));
    }
  }
  return newGeneration;
}

function makeGeneration(traderConfig: TraderConfig, opts: GeneticOpts, gen: number): TraderWorker[] {
  let ind = 0;
  const generation = [];
  while (ind < opts.popSize) {
    // Add best indiv (no mutation copy of config)
    if (ind === 0) {
      generation.push(
        createTraderWorker(
          traderConfig,
          `${traderConfig.name}-gen${gen}-ind${ind}`,
          traderConfig.stratOpts,
          opts.silent
        )
      );
    } else {
      generation.push(randomIndiv(traderConfig, opts, gen, ind));
    }
    ind++;
  }
  return generation;
}

/* tslint:disable */
export class Optimizer {
  public static runningTraders: TraderWorker[] = [];
  public static pqueue: PQueue;
  public static getQueue(concurrency: number): PQueue {
    if (Optimizer.pqueue) Optimizer.pqueue.clear();
    Optimizer.pqueue = new PQueue({ concurrency, autoStart: true });
    return Optimizer.pqueue;
  }

  public static async genetic(trader: TraderConfig, opts: GeneticOpts) {
    let gen = 0;
    const traderConfig = { ...trader };
    let generation;
    while (gen < opts.generation) {
      try {
        generation = !generation
          ? makeGeneration(traderConfig, opts, gen)
          : breedNewGeneration(traderConfig, generation, opts, gen);
        // Clear promise queue
        const pqueue = Optimizer.getQueue(opts.threads);
        pqueue.clear();
        // Add promise to execute inside queue (start executing it)
        generation.forEach((t: TraderWorker) => {
          pqueue
            .add(
              // Exec trader task
              () =>
                new Promise(async (resolve, reject) => {
                  try {
                    // avoid resimulating elite individual
                    if (t.hasRunned !== true) {
                      for (let i = 0; i < opts.envs.length; i++) {
                        t.config.env.backtest = opts.envs[i];
                        t.config.flush = i === 0 ? true : false;
                        await t.init(); // flush only first envs
                        await t.start();
                        await t.stop();
                        if (!t.fitnesses) t.fitnesses = [];
                        t.fitnesses.push(calcFitness(t));
                      }
                    }
                    t.hasRunned = true;
                    resolve();
                  } catch (error) {
                    // set fitness to -1 on error
                    if (!t.fitnesses) t.fitnesses = [];
                    t.fitnesses.push({
                      currentProfit: -1,
                      percentTradeWin: -1,
                      sharpeRatio: -1,
                      tradeFrequency: -1,
                      total: -1,
                    });
                    if (t.trader.status !== Status.STOP) await t.stop().catch(error => logger.error(error));
                    reject(error);
                  }
                })
            )
            .catch(error => {
              logger.error(error);
              // logger.error(new Error(`Problem while running ${t.config.name}`));
            });
        });
        // Execute traders with batchSize = Optimize.threadsSize
        // Wait end of runnings trader
        await pqueue.onIdle();

        // LOGGING
        // sort by fitness
        const g = generation.sort((a: any, b: any) => getFitness(b) - getFitness(a));
        logger.info('RESULT GEN ' + gen);
        const fitnesses = g.map((t: any) => getFitness(t));
        logger.info(
          g
            .map((t: TraderWorker) => {
              const total = getFitness(t);
              const currentProfit = getFitness(t, 'currentProfit');
              const percentTradeWin = getFitness(t, 'percentTradeWin');
              const sharpeRatio = getFitness(t, 'sharpeRatio');
              const tradeFrequency = getFitness(t, 'tradeFrequency');
              return `[${
                t.config.name
              }] total: ${total}, currentProfit: ${currentProfit}, percentTradeWin: ${percentTradeWin}, sharpeRatio: ${sharpeRatio}, tradeFrequency: ${tradeFrequency}`;
            })
            .join('\n')
        );
        logger.info(
          'mean: ' + mean(...fitnesses) + ' min: ' + Math.min(...fitnesses) + ' max: ' + Math.max(...fitnesses)
        );
        // Flush config of the generation
        mkdirSync(`optimizer/genetic/${traderConfig.name}`, { recursive: true });
        writeFileSync(
          `optimizer/genetic/${traderConfig.name}/gen${gen}.json`,
          `${JSON.stringify(
            {
              result: {
                mean: mean(...fitnesses),
                min: Math.min(...fitnesses),
                max: Math.max(...fitnesses),
              },
              gen: g.map(t => ({ name: t.config.name, fitness: t.fitnesses, config: t.config.stratOpts })),
            },
            null,
            2
          )}`
        );
        gen++;
      } catch (error) {
        if (generation) generation.forEach(t => t.stop().catch(error => logger.error(error)));
        logger.error(error);
        throw Error('Problem during genetic optimization');
      }
    }
  }
}

// helper
function daysBetween(date1: Date, date2: Date) {
  // Get 1 day in milliseconds
  const oneDay = 1000 * 60 * 60 * 24;
  // Calculate the difference in milliseconds
  const diffms = date2.getTime() - date1.getTime();
  // Convert back to days and return
  return Math.round(diffms / oneDay);
}
