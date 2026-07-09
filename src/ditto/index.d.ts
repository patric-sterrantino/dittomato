interface IJSONFlat {
    [key: string]: string;
}

declare const driver: {
    base: IJSONFlat;
    de: IJSONFlat;
    fr: IJSONFlat;
};

export = driver;
