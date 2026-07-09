const signs_1___base = require('./signs-1___base.json');
const components_root___base = require('./components-root___base.json');
const reportingportal___base = require('./reportingportal___base.json');
const usasigns___base = require('./usasigns___base.json');
const frenchsigns___base = require('./frenchsigns___base.json');
const signs___base = require('./signs___base.json');
const components___base = require('./components___base.json');
const harvested___base = require('./harvested___base.json');
const components_root___de = require('./components-root___de.json');
const reportingportal___de = require('./reportingportal___de.json');
const signs_1___de = require('./signs-1___de.json');
const components___de = require('./components___de.json');
const components_root___fr = require('./components-root___fr.json');
const reportingportal___fr = require('./reportingportal___fr.json');
const signs_1___fr = require('./signs-1___fr.json');
const components___fr = require('./components___fr.json');

module.exports = {
    base: {
        ...signs_1___base,
        ...components_root___base,
        ...reportingportal___base,
        ...usasigns___base,
        ...frenchsigns___base,
        ...signs___base,
        ...components___base,
        ...harvested___base
    },
    de: {
        ...components_root___de,
        ...reportingportal___de,
        ...signs_1___de,
        ...components___de
    },
    fr: {
        ...components_root___fr,
        ...reportingportal___fr,
        ...signs_1___fr,
        ...components___fr
    }
};
