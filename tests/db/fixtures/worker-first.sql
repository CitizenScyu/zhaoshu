CREATE TABLE download_tasks(
  id serial PRIMARY KEY,book_id int,title text,author text,status text,source_url text,
  chapters_total int DEFAULT 0,chapters_done int DEFAULT 0,chars_total int DEFAULT 0,
  error text DEFAULT '',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now()
);
INSERT INTO download_tasks(book_id,title,author,status,source_url)
VALUES(9,'worker book','','pending','https://example.invalid/book/9');
