-- Create the templates table
CREATE TABLE templates (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title text NOT NULL,
  category text NOT NULL,
  preview_image text,
  download_url text,
  tags text[],
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows anyone to read templates
CREATE POLICY "Allow public read access on templates" 
ON templates FOR SELECT USING (true);

-- Create a storage bucket for template assets (images, files) if it doesn't exist
INSERT INTO storage.buckets (id, name, public) 
VALUES ('template_assets', 'template_assets', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access to the storage bucket
CREATE POLICY "Public Access" 
ON storage.objects FOR SELECT 
USING (bucket_id = 'template_assets');

-- Insert some dummy data for initial testing
INSERT INTO templates (title, category, preview_image, download_url, tags) VALUES
('Q3 Strategic Roadmap', 'Roadmap', 'https://images.unsplash.com/photo-1542744173-8e7e53415bb0?q=80&w=600&auto=format&fit=crop', '#', ARRAY['strategy', 'q3', 'planning']),
('Product Launch Timeline', 'Timeline', 'https://images.unsplash.com/photo-1507537297725-24a1c029d3ca?q=80&w=600&auto=format&fit=crop', '#', ARRAY['product', 'launch']),
('Corporate SWOT Analysis', 'SWOT', 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?q=80&w=600&auto=format&fit=crop', '#', ARRAY['analysis', 'corporate']),
('2024 Tech Roadmap', 'Roadmap', 'https://images.unsplash.com/photo-1512758684632-a6f7116cb798?q=80&w=600&auto=format&fit=crop', '#', ARRAY['tech', '2024']),
('Marketing Campaign Timeline', 'Timeline', 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?q=80&w=600&auto=format&fit=crop', '#', ARRAY['marketing', 'campaign']),
('Startup SWOT Matrix', 'SWOT', 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?q=80&w=600&auto=format&fit=crop', '#', ARRAY['startup', 'business']);
