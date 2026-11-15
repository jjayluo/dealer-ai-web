CREATE TABLE IF NOT EXISTS inventory (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 stock_number text NOT NULL UNIQUE,
 year integer NOT NULL CHECK (year BETWEEN 1886 AND 2100),
 make text NOT NULL,
 model text NOT NULL,
 mileage integer NOT NULL CHECK (mileage >= 0),
 asking_price_cents integer NOT NULL CHECK (asking_price_cents >= 0),
 availability text NOT NULL CHECK (availability IN ('available','pending','sold','unknown')),
 availability_verified_at timestamptz,
 history_summary text,
 inspection_notes text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL,
 email text,
 phone text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS leads (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 customer_id integer NOT NULL REFERENCES customers(id),
 vehicle_id integer REFERENCES inventory(id),
 inquiry text NOT NULL,
 status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','closed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
